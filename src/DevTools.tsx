import React, { useState, useEffect, useRef, useCallback, RefObject } from 'react';
import { X, Terminal, Radio, Wifi, Database, Trash2, ChevronDown, ChevronUp, Folder, File, CornerUpLeft } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

type LogLevel = 'log' | 'warn' | 'error' | 'info';
type LogSource = 'shell' | 'game';

interface LogEntry {
  id: number;
  level: LogLevel;
  source: LogSource;
  msg: string;
  time: string;
}

interface MsgEntry {
  id: number;
  dir: 'shell→game' | 'game→shell';
  type: string;
  payload: string;
  time: string;
}

interface NetEntry {
  id: number;
  method: string;
  url: string;
  status: number | 'ERR' | '…';
  type: string;
  size: string;
  dur: string;
  time: string;
}

type Tab = 'console' | 'messages' | 'network' | 'storage';
type StorageTab = 'local' | 'session' | 'cookies' | 'opfs';

interface OpfsEntry {
  name: string;
  kind: 'file' | 'directory';
  handle: any;
  size?: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let _id = 0;
const uid = () => ++_id;

const ts = () => {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => n.toString().padStart(2, '0'))
    .join(':');
};

const serialize = (v: unknown): string => {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'object') {
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
  }
  return String(v);
};

const formatBytes = (b: number): string => {
  if (b < 1024) return b + 'B';
  if (b < 1048576) return (b / 1024).toFixed(1) + 'KB';
  return (b / 1048576).toFixed(1) + 'MB';
};

// ─── Main Component ───────────────────────────────────────────────────────────

interface DevToolsProps {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  activeGame: string | null;
  onClose: () => void;
}

export default function DevTools({ iframeRef, activeGame, onClose }: DevToolsProps) {
  const [tab, setTab] = useState<Tab>('console');
  const [storeTab, setStoreTab] = useState<StorageTab>('local');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [msgs, setMsgs] = useState<MsgEntry[]>([]);
  const [nets, setNets] = useState<NetEntry[]>([]);
  const [storeData, setStoreData] = useState<[string, string][]>([]);
  
  // OPFS State
  const [opfsStack, setOpfsStack] = useState<{name: string, handle: any}[]>([]);
  const [opfsEntries, setOpfsEntries] = useState<OpfsEntry[]>([]);
  const currentOpfsHandleRef = useRef<any>(null);

  const [filter, setFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all');
  const [consoleInput, setConsoleInput] = useState('');
  const [height, setHeight] = useState(280);
  const [dragging, setDragging] = useState(false);
  const dragStartY = useRef(0);
  const dragStartH = useRef(0);
  const logEndRef = useRef<HTMLDivElement>(null);
  const patchedRef = useRef(false);
  const origConsole = useRef<Record<string, (...args: unknown[]) => void>>({});

  // ─── Console interception (shell scope) ───────────────────────────────────

  const addLog = useCallback((level: LogLevel, source: LogSource, args: unknown[]) => {
    const msg = args.map(serialize).join(' ');
    setLogs(prev => [...prev.slice(-499), { id: uid(), level, source, msg, time: ts() }]);
  }, []);

  useEffect(() => {
    if (patchedRef.current) return;
    patchedRef.current = true;

    (['log', 'warn', 'error', 'info'] as LogLevel[]).forEach(m => {
      origConsole.current[m] = (console[m] as (...args: unknown[]) => void).bind(console);
      (console as unknown as Record<string, (...args: unknown[]) => void>)[m] = (...args: unknown[]) => {
        origConsole.current[m](...args);
        addLog(m, 'shell', args);
      };
    });

    const onError = (e: ErrorEvent) =>
      addLog('error', 'shell', [`${e.message} (${e.filename}:${e.lineno})`]);
    const onReject = (e: PromiseRejectionEvent) =>
      addLog('error', 'shell', ['Unhandled rejection: ' + e.reason]);

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onReject);

    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onReject);
    };
  }, [addLog]);

  // ─── Game iframe console relay ────────────────────────────────────────────

  useEffect(() => {
    const injectRelay = () => {
      try {
        const iwin = iframeRef.current?.contentWindow as (Window & {
          __cadmiumRelayInstalled?: boolean;
          console: Console;
        }) | null | undefined;
        if (!iwin || iwin.__cadmiumRelayInstalled) return;
        iwin.__cadmiumRelayInstalled = true;

        (['log', 'warn', 'error', 'info'] as LogLevel[]).forEach(m => {
          const orig = (iwin.console[m] as (...args: unknown[]) => void).bind(iwin.console);
          (iwin.console as unknown as Record<string, (...args: unknown[]) => void>)[m] = (...args: unknown[]) => {
            orig(...args);
            window.postMessage(
              { __cdvt: true, level: m, args: args.map(serialize) },
              '*'
            );
          };
        });

        // Forward game errors too
        iwin.addEventListener('error', (e: ErrorEvent) => {
          window.postMessage(
            { __cdvt: true, level: 'error', args: [`[game] ${e.message} (${e.filename}:${e.lineno})`] },
            '*'
          );
        });
      } catch {
        // cross-origin guard — ignore silently
      }
    };

    const iframe = iframeRef.current;
    if (iframe) {
      iframe.addEventListener('load', injectRelay);
      injectRelay(); // try immediately if already loaded
    }

    return () => {
      iframe?.removeEventListener('load', injectRelay);
    };
  }, [iframeRef, activeGame]);

  // ─── postMessage monitoring ───────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      // Game console relay
      if (e.data?.__cdvt) {
        addLog(e.data.level as LogLevel, 'game', e.data.args);
        return;
      }
      // Actual shell↔game messages
      if (!e.data || typeof e.data !== 'object') return;
      const dir = e.source === iframeRef.current?.contentWindow
        ? 'game→shell' as const
        : 'shell→game' as const;
      const type = e.data.type ?? '(no type)';
      let payload = '';
      try { payload = JSON.stringify(e.data, null, 2); } catch { payload = String(e.data); }
      setMsgs(prev => [...prev.slice(-199), { id: uid(), dir, type, payload, time: ts() }]);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [addLog, iframeRef]);

  // ─── Network interception ─────────────────────────────────────────────────

  useEffect(() => {
    const origFetch = window.fetch;
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      const method = init?.method ?? (typeof input !== 'string' && !(input instanceof URL) ? (input as Request).method : 'GET');
      const start = Date.now();
      const entry: NetEntry = { id: uid(), method, url, status: '…', type: 'fetch', size: '-', dur: '-', time: ts() };
      setNets(prev => [...prev.slice(-99), entry]);

      return origFetch(input, init)
        .then(res => {
          const len = res.headers.get('content-length');
          setNets(prev => prev.map(n => n.id === entry.id
            ? { ...n, status: res.status, size: len ? formatBytes(+len) : '-', dur: (Date.now() - start) + 'ms' }
            : n));
          return res;
        })
        .catch(err => {
          setNets(prev => prev.map(n => n.id === entry.id
            ? { ...n, status: 'ERR', dur: (Date.now() - start) + 'ms' }
            : n));
          throw err;
        });
    };

    return () => { window.fetch = origFetch; };
  }, []);

  // ─── OPFS Reader ──────────────────────────────────────────────────────────

  const loadOpfsDir = useCallback(async (handle?: any) => {
    try {
      const dirHandle = handle || await (navigator.storage as any).getDirectory();
      currentOpfsHandleRef.current = dirHandle;
      const entries: OpfsEntry[] = [];
      const iterator = dirHandle.entries();
      
      for await (const [name, entryHandle] of iterator) {
        let size = undefined;
        if (entryHandle.kind === 'file') {
          const file = await entryHandle.getFile();
          size = file.size;
        }
        entries.push({ name, kind: entryHandle.kind, handle: entryHandle, size });
      }

      entries.sort((a, b) => {
        if (a.kind === b.kind) return a.name.localeCompare(b.name);
        return a.kind === 'directory' ? -1 : 1;
      });
      setOpfsEntries(entries);
    } catch (err) {
      addLog('error', 'shell', ['OPFS Read Error: ' + String(err)]);
    }
  }, [addLog]);

  const enterOpfsDir = (name: string, handle: any) => {
    setOpfsStack(prev => [...prev, { name, handle }]);
    loadOpfsDir(handle);
  };

  const popOpfsDir = () => {
    setOpfsStack(prev => {
      const next = prev.slice(0, -1);
      const parentHandle = next.length > 0 ? next[next.length - 1].handle : undefined;
      loadOpfsDir(parentHandle);
      return next;
    });
  };

  const dumpOpfsFile = async (handle: any) => {
    try {
      const file = await handle.getFile();
      const text = await file.text();
      addLog('info', 'shell', [`[OPFS] Read file "${file.name}" (${formatBytes(file.size)}):`, text]);
      setTab('console');
    } catch (err) {
      addLog('error', 'shell', ['OPFS Read File Error: ' + String(err)]);
    }
  };

  // ─── Storage reader ───────────────────────────────────────────────────────

  const readStorage = useCallback((mode: StorageTab) => {
    if (mode === 'opfs') return;
    const items: [string, string][] = [];
    try {
      if (mode === 'local') {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i)!;
          items.push([k, localStorage.getItem(k) ?? '']);
        }
      } else if (mode === 'session') {
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i)!;
          items.push([k, sessionStorage.getItem(k) ?? '']);
        }
      } else {
        document.cookie.split(';').forEach(c => {
          const [k, ...rest] = c.trim().split('=');
          if (k) items.push([k, rest.join('=')]);
        });
      }
    } catch { /* blocked */ }
    setStoreData(items);
  }, []);

  useEffect(() => {
    if (tab === 'storage') {
      if (storeTab === 'opfs') {
        loadOpfsDir(currentOpfsHandleRef.current);
      } else {
        readStorage(storeTab);
      }
    }
  }, [tab, storeTab, readStorage, loadOpfsDir]);

  // ─── Scroll to bottom on new logs ────────────────────────────────────────

  useEffect(() => {
    if (tab === 'console') logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs, tab]);

  // ─── Drag-to-resize ───────────────────────────────────────────────────────

  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
    dragStartY.current = e.clientY;
    dragStartH.current = height;
  };

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const delta = dragStartY.current - e.clientY;
      setHeight(Math.max(180, Math.min(window.innerHeight * 0.8, dragStartH.current + delta)));
    };
    const onUp = () => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  // ─── Eval expression ─────────────────────────────────────────────────────

  const runExpr = () => {
    const expr = consoleInput.trim();
    if (!expr) return;
    addLog('log', 'shell', ['> ' + expr]);
    try {
      // eslint-disable-next-line no-eval
      const result = eval(expr);
      if (result !== undefined) addLog('log', 'shell', [result]);
    } catch (err) {
      addLog('error', 'shell', [(err as Error).message]);
    }
    setConsoleInput('');
  };

  // ─── Filtered logs ───────────────────────────────────────────────────────

  const visibleLogs = logs.filter(l => {
    if (levelFilter !== 'all' && l.level !== levelFilter) return false;
    if (filter && !l.msg.toLowerCase().includes(filter.toLowerCase())) return false;
    return true;
  });

  // ─── Clear current tab ───────────────────────────────────────────────────

  const clearTab = () => {
    if (tab === 'console') setLogs([]);
    else if (tab === 'messages') setMsgs([]);
    else if (tab === 'network') setNets([]);
  };

  // ─── Render ───────────────────────────────────────────────────────────────

  const tabs: { key: Tab; label: string; icon: React.ReactNode; count?: number }[] = [
    { key: 'console', label: 'Console', icon: <Terminal size={13} />, count: logs.filter(l => l.level === 'error').length || undefined },
    { key: 'messages', label: 'Messages', icon: <Radio size={13} />, count: msgs.length || undefined },
    { key: 'network', label: 'Network', icon: <Wifi size={13} />, count: nets.length || undefined },
    { key: 'storage', label: 'Storage', icon: <Database size={13} /> },
  ];

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-[95] flex flex-col bg-[#060606] border-t border-white/10 shadow-2xl font-mono"
      style={{ height }}
    >
      {/* Drag handle */}
      <div
        onMouseDown={onDragStart}
        className="h-[5px] cursor-ns-resize flex-shrink-0 flex items-center justify-center group"
        title="Drag to resize"
      >
        <div className="w-12 h-[3px] rounded-full bg-white/10 group-hover:bg-cadmium-red/50 transition-colors" />
      </div>

      {/* Tab bar */}
      <div className="flex items-center border-b border-white/10 flex-shrink-0 bg-[#0a0a0a]">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-4 py-2 text-[10px] uppercase tracking-widest transition-all border-b-2 ${
              tab === t.key
                ? 'text-white border-cadmium-red bg-white/5'
                : 'text-white/30 border-transparent hover:text-white/60'
            }`}
          >
            {t.icon}
            {t.label}
            {t.count ? (
              <span className={`text-[9px] px-1 rounded ${t.key === 'console' ? 'bg-cadmium-red/20 text-cadmium-red' : 'bg-white/10 text-white/50'}`}>
                {t.count}
              </span>
            ) : null}
          </button>
        ))}

        <div className="ml-auto flex items-center gap-2 pr-3">
          {/* Console filter pills */}
          {tab === 'console' && (
            <div className="flex items-center gap-1 mr-2">
              {(['all', 'log', 'warn', 'error', 'info'] as const).map(l => (
                <button
                  key={l}
                  onClick={() => setLevelFilter(l)}
                  className={`text-[9px] px-2 py-0.5 rounded uppercase tracking-wider transition-all ${
                    levelFilter === l
                      ? 'bg-cadmium-red/20 text-cadmium-red border border-cadmium-red/30'
                      : 'text-white/20 hover:text-white/50'
                  }`}
                >
                  {l}
                </button>
              ))}
            </div>
          )}
          {tab === 'storage' && (
            <button 
              onClick={() => {
                if (storeTab === 'opfs') {
                  loadOpfsDir(currentOpfsHandleRef.current);
                } else {
                  readStorage(storeTab);
                }
              }} 
              className="text-[9px] text-white/30 hover:text-white/60 uppercase tracking-widest transition-colors px-2"
            >
              Refresh
            </button>
          )}
          <button onClick={clearTab} title="Clear" className="p-1.5 text-white/20 hover:text-cadmium-red transition-colors">
            <Trash2 size={12} />
          </button>
          <button onClick={onClose} title="Close DevTools (F12)" className="p-1.5 text-white/20 hover:text-white transition-colors">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* ─── CONSOLE ─────────────────────────────────────────────────── */}
      {tab === 'console' && (
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="flex-shrink-0 px-3 py-1.5 border-b border-white/5">
            <input
              type="text"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Filter output..."
              className="w-full bg-transparent text-[11px] text-white/70 outline-none placeholder:text-white/20"
            />
          </div>
          <div className="flex-1 overflow-y-auto text-[11px] leading-relaxed">
            {visibleLogs.map(l => (
              <div
                key={l.id}
                className={`flex gap-2 px-3 py-1 border-b border-white/[0.03] hover:bg-white/[0.02] ${
                  l.level === 'error' ? 'bg-red-900/10' :
                  l.level === 'warn'  ? 'bg-yellow-900/10' : ''
                }`}
              >
                <span className={`flex-shrink-0 w-[34px] text-[9px] text-center rounded px-1 ${
                  l.level === 'error' ? 'text-cadmium-red bg-cadmium-red/10' :
                  l.level === 'warn'  ? 'text-yellow-400 bg-yellow-400/10' :
                  l.level === 'info'  ? 'text-blue-400 bg-blue-400/10' :
                  'text-white/20 bg-white/5'
                }`}>{l.level}</span>
                <span className={`flex-shrink-0 text-[9px] px-1 rounded ${
                  l.source === 'game' ? 'text-cadmium-red/60 bg-cadmium-red/5' : 'text-white/20 bg-white/5'
                }`}>{l.source}</span>
                <span className="flex-1 text-white/70 whitespace-pre-wrap break-all">{l.msg}</span>
                <span className="flex-shrink-0 text-white/20 text-[9px] tabular-nums">{l.time}</span>
              </div>
            ))}
            {visibleLogs.length === 0 && (
              <p className="text-white/20 text-[10px] uppercase tracking-widest text-center py-8">No output yet</p>
            )}
            <div ref={logEndRef} />
          </div>
          <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 border-t border-white/10 bg-[#0a0a0a]">
            <span className="text-cadmium-red text-[11px]">&gt;</span>
            <input
              type="text"
              value={consoleInput}
              onChange={e => setConsoleInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') runExpr(); }}
              placeholder="Run JavaScript in shell scope..."
              className="flex-1 bg-transparent text-[11px] text-white/80 outline-none placeholder:text-white/20"
            />
            <button onClick={runExpr} className="text-[9px] text-white/30 hover:text-cadmium-red uppercase tracking-widest transition-colors px-2 py-1 border border-white/10 rounded">
              Run
            </button>
          </div>
        </div>
      )}

      {/* ─── MESSAGES ────────────────────────────────────────────────── */}
      {tab === 'messages' && (
        <div className="flex-1 overflow-y-auto text-[10px]">
          {msgs.length === 0 && (
            <p className="text-white/20 uppercase tracking-widest text-center py-8">No postMessage events captured yet</p>
          )}
          {[...msgs].reverse().map(m => (
            <div key={m.id} className="border-b border-white/[0.03] hover:bg-white/[0.02] px-3 py-1.5">
              <div className="flex items-center gap-2 mb-0.5">
                <span className={`text-[9px] px-1.5 py-0.5 rounded ${
                  m.dir === 'game→shell' ? 'bg-cadmium-red/20 text-cadmium-red' : 'bg-blue-400/10 text-blue-400'
                }`}>{m.dir}</span>
                <span className="text-white/60 font-bold">{m.type}</span>
                <span className="ml-auto text-white/20 tabular-nums">{m.time}</span>
              </div>
              <pre className="text-white/30 whitespace-pre-wrap break-all text-[9px] max-h-20 overflow-y-auto">{m.payload}</pre>
            </div>
          ))}
        </div>
      )}

      {/* ─── NETWORK ─────────────────────────────────────────────────── */}
      {tab === 'network' && (
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="flex-shrink-0 grid text-[9px] text-white/30 uppercase tracking-widest px-3 py-1.5 border-b border-white/10 bg-[#0a0a0a]"
            style={{ gridTemplateColumns: '48px 24px 1fr 44px 52px 60px' }}>
            <span>Status</span><span>Meth</span><span>URL</span><span>Type</span><span>Size</span><span className="text-right">Time</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            {nets.length === 0 && (
              <p className="text-white/20 uppercase tracking-widest text-center py-8 text-[10px]">No requests captured yet</p>
            )}
            {[...nets].reverse().map(n => (
              <div key={n.id} className="grid text-[10px] px-3 py-1.5 border-b border-white/[0.03] hover:bg-white/[0.02] items-center"
                style={{ gridTemplateColumns: '48px 24px 1fr 44px 52px 60px' }}>
                <span className={`font-bold ${
                  n.status === 'ERR' || (typeof n.status === 'number' && n.status >= 400) ? 'text-cadmium-red' :
                  n.status === '…' ? 'text-white/30' :
                  (typeof n.status === 'number' && n.status >= 300) ? 'text-yellow-400' : 'text-green-400'
                }`}>{n.status}</span>
                <span className="text-white/30 text-[9px]">{n.method.slice(0, 4)}</span>
                <span className="text-white/60 truncate">{n.url}</span>
                <span className="text-white/30">{n.type}</span>
                <span className="text-white/30">{n.size}</span>
                <span className="text-white/30 text-right tabular-nums">{n.dur}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── STORAGE ─────────────────────────────────────────────────── */}
      {tab === 'storage' && (
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="flex-shrink-0 flex border-b border-white/10">
            {(['local', 'session', 'cookies', 'opfs'] as StorageTab[]).map(s => (
              <button
                key={s}
                onClick={() => setStoreTab(s)}
                className={`text-[9px] uppercase tracking-widest px-4 py-2 border-b-2 transition-all ${
                  storeTab === s ? 'text-white border-cadmium-red' : 'text-white/30 border-transparent hover:text-white/60'
                }`}
              >
                {s === 'local' ? 'localStorage' : s === 'session' ? 'sessionStorage' : s === 'cookies' ? 'Cookies' : 'OPFS'}
              </button>
            ))}
          </div>
          
          {storeTab === 'opfs' ? (
            <div className="flex flex-col flex-1 overflow-hidden">
              {/* OPFS Breadcrumbs */}
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/10 bg-white/[0.02] text-[10px]">
                <button
                  disabled={opfsStack.length === 0}
                  onClick={popOpfsDir}
                  className="p-1 text-white/40 hover:text-white disabled:opacity-30 transition-colors"
                >
                  <CornerUpLeft size={10} />
                </button>
                <span className="text-white/50">/</span>
                <span className="text-white/70">root</span>
                {opfsStack.map((step, i) => (
                  <React.Fragment key={i}>
                    <span className="text-white/50">/</span>
                    <span className="text-white/70">{step.name}</span>
                  </React.Fragment>
                ))}
              </div>
              
              {/* OPFS Entries */}
              <div className="flex-1 overflow-y-auto">
                {opfsEntries.length === 0 && (
                  <p className="text-white/20 uppercase tracking-widest text-center py-8 text-[10px]">Empty directory</p>
                )}
                {opfsEntries.length > 0 && (
                  <>
                    <div className="grid text-[9px] text-white/30 uppercase tracking-widest px-3 py-1.5 border-b border-white/10 bg-[#0a0a0a]"
                         style={{ gridTemplateColumns: '24px 1fr 80px' }}>
                      <span></span><span>Name</span><span className="text-right">Size</span>
                    </div>
                    {opfsEntries.map((ent, i) => (
                      <div 
                        key={i} 
                        className="grid text-[10px] px-3 py-1.5 border-b border-white/[0.03] hover:bg-white/[0.05] items-center cursor-pointer transition-colors"
                        style={{ gridTemplateColumns: '24px 1fr 80px' }}
                        onClick={() => ent.kind === 'directory' ? enterOpfsDir(ent.name, ent.handle) : dumpOpfsFile(ent.handle)}
                        title={ent.kind === 'file' ? 'Click to read file contents in console' : 'Click to enter folder'}
                      >
                        <span className="text-white/40 flex items-center justify-center">
                          {ent.kind === 'directory' ? <Folder size={12} className="text-blue-400" /> : <File size={12} />}
                        </span>
                        <span className={`truncate pr-4 ${ent.kind === 'directory' ? 'text-white/80' : 'text-white/60'}`}>{ent.name}</span>
                        <span className="text-white/40 text-right">{ent.size !== undefined ? formatBytes(ent.size) : '-'}</span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto">
              {storeData.length === 0 && (
                <p className="text-white/20 uppercase tracking-widest text-center py-8 text-[10px]">No items</p>
              )}
              {storeData.length > 0 && (
                <>
                  <div className="grid text-[9px] text-white/30 uppercase tracking-widest px-3 py-1.5 border-b border-white/10 bg-[#0a0a0a]"
                    style={{ gridTemplateColumns: '1fr 1fr' }}>
                    <span>Key</span><span>Value</span>
                  </div>
                  {storeData.map(([k, v], i) => (
                    <div key={i} className="grid text-[10px] px-3 py-1.5 border-b border-white/[0.03] hover:bg-white/[0.02]"
                      style={{ gridTemplateColumns: '1fr 1fr' }}>
                      <span className="text-cadmium-red/80 truncate pr-4" title={k}>{k}</span>
                      <span className="text-white/50 truncate" title={v}>{v}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
