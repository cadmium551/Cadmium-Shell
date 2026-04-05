import React, { useState, useEffect, useRef } from 'react';
import { Upload, Play, Trash2, X, Gamepad2, Layers, FileCode, FolderOpen, MoreVertical, Settings, Folder } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// Constants - use local path for Service Worker interception
const SANDBOX_BASE = "/vfs";
const APP_VERSION = "1.4.0";

interface Game {
  id: string;
  name: string;
  mainFile?: string;
}

export default function App() {
  const [games, setGames] = useState<Game[]>([]);
  const [activeGame, setActiveGame] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [swReady, setSwReady] = useState(false);
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [browsingGame, setBrowsingGame] = useState<string | null>(null);
  const [gameFiles, setGameFiles] = useState<string[]>([]);
  const [showGlobalSettings, setShowGlobalSettings] = useState(false);
  const [purgeConfirmation, setPurgeConfirmation] = useState("");
  const [purgeTarget, setPurgeTarget] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [showOverlayBar, setShowOverlayBar] = useState(true);
  const [strippingGame, setStrippingGame] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const barTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const threshold = window.innerHeight - 5;
      if (e.clientY >= threshold) {
        setShowOverlayBar(true);
        if (barTimeoutRef.current) window.clearTimeout(barTimeoutRef.current);
        barTimeoutRef.current = window.setTimeout(() => {
          setShowOverlayBar(false);
        }, 3000);
      }
    };

    if (activeGame) {
      window.addEventListener('mousemove', handleMouseMove);
      setShowOverlayBar(true);
      if (barTimeoutRef.current) window.clearTimeout(barTimeoutRef.current);
      barTimeoutRef.current = window.setTimeout(() => setShowOverlayBar(false), 3000);
    } else {
      window.removeEventListener('mousemove', handleMouseMove);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      if (barTimeoutRef.current) window.clearTimeout(barTimeoutRef.current);
    };
  }, [activeGame]);

  useEffect(() => {
    console.log(`[Cadmium] Initializing Shell v${APP_VERSION}`);
    
    // Register Service Worker
    if ('serviceWorker' in navigator) {
      // Unregister any rogue game Service Workers
      navigator.serviceWorker.getRegistrations().then(registrations => {
        for (let registration of registrations) {
          if (registration.scope.includes('/vfs/')) {
            console.log('[Cadmium] Unregistering rogue game SW:', registration.scope);
            registration.unregister();
          }
        }
      });

      navigator.serviceWorker.register('/sw.js', {
        // @ts-ignore
        type: import.meta.env?.DEV ? 'module' : 'classic'
      })
        .then(reg => {
          console.log('[Cadmium] SW registered');
          
          reg.onupdatefound = () => {
            const installingWorker = reg.installing;
            if (installingWorker) {
              installingWorker.onstatechange = () => {
                if (installingWorker.state === 'activated') {
                  console.log('[Cadmium] SW updated, reloading...');
                  window.location.reload();
                }
              };
            }
          };
        })
        .catch(err => console.error('[Cadmium] SW registration failed', err));
      
      if (navigator.serviceWorker.controller) {
        setSwReady(true);
      }

      const handleControllerChange = () => {
        if (navigator.serviceWorker.controller) {
          setSwReady(true);
        }
      };
      navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);
    }

    // Initialize OPFS Worker
    workerRef.current = new Worker('/opfs-worker.js?v=2');
    workerRef.current.onmessage = (e) => {
      const { type, games: fetchedGames, error, gameId, data } = e.data;
      
      if (type === 'LIST_SUCCESS') {
        console.log(`[Cadmium] Games list updated: ${fetchedGames.length} games found`);
        setGames(fetchedGames.map((game: any) => {
          if (typeof game === 'string') {
            return { id: game, name: game, mainFile: 'index.html' };
          }
          return { 
            id: game.id, 
            name: game.id,
            mainFile: game.mainFile 
          };
        }));
      } else if (type === 'WRITE_SUCCESS' || type === 'DELETE_SUCCESS') {
        console.log(`[Cadmium] Operation success: ${type} for ${gameId}`);
        if (type === 'WRITE_SUCCESS') {
          console.log(`[Cadmium] Game ${gameId} imported successfully`);
        } else if (type === 'DELETE_SUCCESS') {
          console.log(`[Cadmium] Game ${gameId} deleted successfully`);
        }
        if (type === 'DELETE_SUCCESS' && gameId === 'ALL') {
          console.log('[Cadmium] All storage cleared');
          setGames([]);
        }
        workerRef.current?.postMessage({ type: 'LIST_GAMES' });
      } else if (type === 'LIST_FILES_SUCCESS') {
        setGameFiles(e.data.files);
      } else if (type === 'SAVE_SUCCESS') {
        console.log(`[Cadmium] Game data saved successfully for ${gameId}`);
      } else if (type === 'LOAD_SUCCESS') {
        console.log(`[Cadmium] Game data loaded for ${gameId}`);
        const iframe = document.querySelector('iframe');
        iframe?.contentWindow?.postMessage({ type: 'LOAD_RESPONSE', data }, '*');
      } else if (type === 'RENAME_SUCCESS') {
        console.log(`[Cadmium] Game renamed: ${e.data.oldId} -> ${e.data.newId}`);
        workerRef.current?.postMessage({ type: 'LIST_GAMES' });
      } else if (type === 'STRIP_SUCCESS') {
        console.log(`[Cadmium] Strip successful for ${e.data.gameId}. Saved ${e.data.savings} bytes.`);
        setStrippingGame(null);
      } else if (type === 'ERROR') {
        console.error(`[Cadmium] Worker Error for ${gameId || 'unknown'}:`, error);
      }
    };

    workerRef.current?.postMessage({ type: 'LIST_GAMES' });

    const handleGlobalClick = () => setActiveMenu(null);
    window.addEventListener('click', handleGlobalClick);

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      // Prompt user before closing to prevent accidental loss (Ctrl+W)
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      workerRef.current?.terminate();
      window.removeEventListener('click', handleGlobalClick);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, []);

  useEffect(() => {
    const handleGameMessage = (e: MessageEvent) => {
      if (e.data?.type === 'SAVE_REQUEST' && activeGame) {
        workerRef.current?.postMessage({ 
          type: 'SAVE_GAME_DATA', 
          payload: { gameId: activeGame, data: e.data.data } 
        });
      } else if (e.data?.type === 'LOAD_REQUEST' && activeGame) {
        workerRef.current?.postMessage({ 
          type: 'LOAD_GAME_DATA', 
          payload: { gameId: activeGame } 
        });
      }
    };

    window.addEventListener('message', handleGameMessage);
    return () => window.removeEventListener('message', handleGameMessage);
  }, [activeGame]);

  const refreshGames = () => {
    workerRef.current?.postMessage({ type: 'LIST_GAMES' });
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsImporting(true);
    // Use the first file's name as the gameId/name
    const mainFile = files[0];
    const gameId = mainFile.name;
    const fileData = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      let path = file.name;
      // If it's the main file or any .html, we treat it as the entry index.html
      // for the VFS to serve it correctly.
      if (path.endsWith('.html')) {
        path = 'index.html';
      }
      
      const arrayBuffer = await file.arrayBuffer();
      fileData.push({ path, content: arrayBuffer });
    }

    workerRef.current?.postMessage({
      type: 'WRITE_FILES',
      payload: { gameId, files: fileData }
    });
    setIsImporting(false);
    e.target.value = '';
  };

  const launchGame = (id: string) => {
    if (!swReady) {
      if (!navigator.serviceWorker.controller) {
        alert("Service Worker is bypassed. If you hard-reloaded the page, please do a normal refresh (F5 or click the reload button) to enable games.");
      } else {
        alert("Cadmium Engine is still initializing. Please wait a moment.");
      }
      return;
    }
    setActiveGame(id);
  };

  const killGame = () => {
    setActiveGame(null);
  };

  const deleteGame = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setDeleteTarget(id);
  };

  const confirmDelete = () => {
    if (deleteTarget) {
      console.log(`[Cadmium] Requesting delete for ${deleteTarget}`);
      workerRef.current?.postMessage({ type: 'DELETE_GAME', payload: { gameId: deleteTarget } });
      setDeleteTarget(null);
    }
  };

  return (
    <div className="min-h-screen bg-cadmium-dark text-white font-sans selection:bg-cadmium-red/30">
      {/* Header */}
      <header className="border-b border-white/5 p-6 flex flex-col lg:flex-row items-center justify-between bg-cadmium-dark sticky top-0 z-10 gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-cadmium-red rounded-lg flex items-center justify-center shadow-lg shadow-cadmium-red/20">
            <Gamepad2 className="text-white" size={24} />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight uppercase italic flex items-center gap-2">
              Cadmium Shell
              <span className="text-[10px] not-italic font-mono bg-white/10 px-1.5 py-0.5 rounded text-white/70">v{APP_VERSION}</span>
            </h1>
          </div>
        </div>
        
        <div className="flex flex-wrap items-center justify-center gap-3">
          <button 
            onClick={() => {
              setShowGlobalSettings(true);
              setPurgeTarget(Math.random().toString(36).substring(2, 8).toUpperCase());
              setPurgeConfirmation("");
            }}
            className="p-3 bg-white/5 hover:bg-white/10 rounded-full transition-all active:scale-95 text-white/80 hover:text-white"
            title="Global Settings"
          >
            <Settings size={20} />
          </button>
          <label className="flex items-center gap-2 bg-cadmium-red hover:bg-cadmium-orange text-white px-8 py-3 rounded-full cursor-pointer transition-all active:scale-95 shadow-xl shadow-cadmium-red/40 group">
            <Upload size={20} className="group-hover:-translate-y-1 transition-transform" />
            <span className="text-sm font-bold uppercase tracking-widest">Import HTML Game</span>
            <input 
              type="file" 
              accept=".html"
              className="hidden" 
              onChange={handleFileUpload}
              disabled={isImporting}
            />
          </label>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto p-8">
        {isImporting && (
          <div className="mb-8 p-4 bg-cadmium-red/10 border border-cadmium-red/20 rounded-xl flex items-center gap-4 animate-pulse">
            <Layers className="text-cadmium-red animate-bounce" />
            <span className="text-cadmium-red font-mono text-sm uppercase tracking-widest">Writing to OPFS...</span>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          <AnimatePresence mode="popLayout">
            {games.map((game) => (
              <motion.div
                key={game.id}
                layout
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className="group relative bg-[#050505] border border-white/5 rounded-3xl overflow-hidden hover:border-cadmium-red/50 transition-all duration-500 shadow-2xl"
              >
                <div className="p-8">
                  <div className="flex items-start justify-between mb-6">
                    <div className="bg-white/5 p-4 rounded-2xl group-hover:bg-cadmium-red/20 transition-all duration-500 group-hover:rotate-6">
                      <Gamepad2 className="text-white/40 group-hover:text-cadmium-red transition-colors" size={32} />
                    </div>
                    <div className="relative">
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveMenu(activeMenu === game.id ? null : game.id);
                        }}
                        className="p-3 text-white/20 hover:text-white hover:bg-white/10 rounded-2xl transition-all duration-300"
                        title="Game Options"
                      >
                        <MoreVertical size={20} />
                      </button>
                      <AnimatePresence>
                        {activeMenu === game.id && (
                          <motion.div
                            initial={{ opacity: 0, y: 10, scale: 0.95 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 10, scale: 0.95 }}
                            className="absolute right-0 mt-2 w-48 bg-cadmium-dark border border-white/10 rounded-2xl shadow-2xl z-20 overflow-hidden"
                          >
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setBrowsingGame(game.id);
                                setGameFiles([]);
                                workerRef.current?.postMessage({ type: 'LIST_FILES', payload: { gameId: game.id } });
                                setActiveMenu(null);
                              }}
                              className="w-full flex items-center gap-3 px-4 py-3 text-left text-sm hover:bg-white/5 transition-colors"
                            >
                              <Folder size={16} className="text-cadmium-red" />
                              Browse Files
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setRenameTarget(game.id);
                                setRenameValue(game.name);
                                setActiveMenu(null);
                              }}
                              className="w-full flex items-center gap-3 px-4 py-3 text-left text-sm hover:bg-white/5 transition-colors border-t border-white/5"
                            >
                              <Layers size={16} className="text-cadmium-red" />
                              Rename Game
                            </button>
                            <button
                              onClick={(e) => {
                                deleteGame(game.id, e);
                                setActiveMenu(null);
                              }}
                              className="w-full flex items-center gap-3 px-4 py-3 text-left text-sm hover:bg-cadmium-red/10 text-cadmium-red transition-colors border-t border-white/5"
                            >
                              <Trash2 size={16} />
                              Delete Game
                            </button>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </div>
                  
                  <h3 className="text-xl font-black mb-2 truncate group-hover:text-cadmium-red transition-colors">{game.name}</h3>
                  <div className="flex items-center gap-2 opacity-50">
                    <div className="w-1 h-1 bg-white rounded-full" />
                    <p className="text-[10px] font-mono uppercase tracking-widest">OPFS: {game.id}</p>
                  </div>
                  
                  <button
                    onClick={() => launchGame(game.id)}
                    className="mt-8 w-full flex items-center justify-center gap-3 bg-white text-black font-black py-4 rounded-2xl hover:bg-cadmium-red hover:text-white transition-all active:scale-95 shadow-lg group-hover:shadow-cadmium-red/20"
                  >
                    <Play size={20} fill="currentColor" />
                    LAUNCH
                  </button>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>

          {games.length === 0 && !isImporting && (
            <div className="col-span-full py-32 flex flex-col items-center justify-center border-2 border-dashed border-white/5 rounded-[3rem] bg-white/[0.02]">
              <div className="bg-white/5 p-8 rounded-full mb-6">
                <Layers className="text-white/10" size={64} />
              </div>
              <p className="text-white/20 font-mono uppercase tracking-[0.3em] text-sm">Cadmium Storage Empty</p>
              <p className="text-white/10 text-[10px] mt-2 uppercase tracking-widest">Import an HTML file to begin</p>
            </div>
          )}
        </div>
      </main>

      {/* Sandbox Overlay */}
      <AnimatePresence>
        {activeGame && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-cadmium-dark flex flex-col"
          >
            {/* Hitbox for status bar - Always on top */}
            <div 
              className="fixed bottom-0 left-0 right-0 h-[5px] z-[100] cursor-pointer"
              onMouseMove={() => {
                setShowOverlayBar(true);
                if (barTimeoutRef.current) window.clearTimeout(barTimeoutRef.current);
                barTimeoutRef.current = window.setTimeout(() => setShowOverlayBar(false), 3000);
              }}
            />
            <AnimatePresence>
              {showOverlayBar && (
                <motion.div 
                  initial={{ y: 50, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: 50, opacity: 0 }}
                  className="absolute bottom-0 left-0 right-0 h-10 bg-cadmium-dark/90 backdrop-blur-md border-t border-white/10 flex items-center justify-between px-4 z-[90]"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-1.5 h-1.5 bg-cadmium-red rounded-full" />
                    <span className="text-[9px] font-mono uppercase tracking-widest text-white/80">Process Active</span>
                  </div>
                  <button 
                    onClick={killGame}
                    className="flex items-center gap-2 bg-cadmium-red/10 hover:bg-cadmium-red text-cadmium-red hover:text-white px-3 py-1 rounded-full text-[9px] font-bold transition-all uppercase tracking-wider border border-cadmium-red/20"
                  >
                    <X size={12} />
                    Quit
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
            <div className="flex-1 relative bg-cadmium-dark">
              {!swReady ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
                  <div className="w-12 h-12 border-4 border-cadmium-red border-t-transparent rounded-full animate-spin" />
                  <p className="text-cadmium-red font-mono text-sm animate-pulse">SYNCHRONIZING VFS...</p>
                </div>
              ) : (
                <iframe
                  src={`${SANDBOX_BASE}/${activeGame}/${games.find(g => g.id === activeGame)?.mainFile || 'index.html'}`}
                  className="w-full h-full border-none bg-black"
                  // Performance and capability hints
                  allow="autoplay; fullscreen; gamepad; microphone; camera; midi; encrypted-media; xr-spatial-tracking; clipboard-read; clipboard-write; cross-origin-isolated"
                  loading="eager"
                  title="Game Sandbox"
                />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Footer Info */}
      <footer className="p-8 border-t border-white/5 mt-auto">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center gap-4 opacity-60 text-[10px] font-mono uppercase tracking-[0.2em]">
          <p>© 2026 Cadmium Systems Engineering</p>
          <div className="flex gap-6">
            <span>OPFS Rooted</span>
            <span>COOP/COEP Headers</span>
            <span>VFS v1.4</span>
          </div>
        </div>
      </footer>
      {/* Browse Files Modal */}
      <AnimatePresence>
        {browsingGame && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] bg-cadmium-dark/80 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-cadmium-dark border border-white/10 rounded-[2rem] w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col shadow-2xl"
            >
              <div className="p-6 border-b border-white/10 flex items-center justify-between bg-white/5">
                <div className="flex items-center gap-3">
                  <FolderOpen className="text-cadmium-red" size={24} />
                  <div>
                    <h2 className="text-lg font-bold uppercase tracking-wider">VFS Explorer</h2>
                    <p className="text-[10px] text-white/70 font-mono uppercase tracking-widest">{browsingGame}</p>
                  </div>
                </div>
                <button 
                  onClick={() => setBrowsingGame(null)}
                  className="p-2 hover:bg-white/10 rounded-full transition-colors"
                >
                  <X size={20} />
                </button>
              </div>
              
              <div className="flex-1 overflow-y-auto p-6">
                {gameFiles.length > 0 ? (
                  <div className="grid gap-2">
                    {gameFiles.map((file, idx) => {
                      const isData = file.startsWith('data/');
                      const isWWW = file.startsWith('www/');
                      return (
                        <div key={idx} className="flex items-center justify-between p-3 bg-white/5 rounded-xl border border-white/5 hover:border-white/10 transition-colors group">
                          <div className="flex items-center gap-3">
                            {isData ? (
                              <Layers size={16} className="text-cadmium-red" />
                            ) : (
                              <FileCode size={16} className="text-white/40" />
                            )}
                            <span className="text-xs font-mono text-white/80">{file}</span>
                          </div>
                          <span className={`text-[8px] font-mono px-1.5 py-0.5 rounded uppercase tracking-widest ${isData ? 'bg-cadmium-red/20 text-cadmium-red' : 'bg-white/10 text-white/40'}`}>
                            {isData ? 'SAVE_DATA' : isWWW ? 'ASSET' : 'SYSTEM'}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center py-12 opacity-20">
                    <Layers size={48} className="mb-4" />
                    <p className="text-sm font-mono uppercase tracking-widest">Scanning Directory...</p>
                  </div>
                )}
              </div>
              
              <div className="p-6 bg-white/5 border-t border-white/10 flex justify-end">
                <button 
                  onClick={() => setBrowsingGame(null)}
                  className="px-6 py-2 bg-white text-black font-bold rounded-xl text-xs uppercase tracking-widest hover:bg-cadmium-red hover:text-white transition-all"
                >
                  Close Explorer
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Global Settings Modal */}
      <AnimatePresence>
        {showGlobalSettings && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] bg-cadmium-dark/80 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-cadmium-dark border border-white/10 rounded-[2rem] w-full max-w-md overflow-hidden shadow-2xl"
            >
              <div className="p-6 border-b border-white/10 flex items-center justify-between bg-white/5">
                <div className="flex items-center gap-3">
                  <Settings className="text-cadmium-red" size={24} />
                  <h2 className="text-lg font-bold uppercase tracking-wider">Shell Settings</h2>
                </div>
                <button 
                  onClick={() => setShowGlobalSettings(false)}
                  className="p-2 hover:bg-white/10 rounded-full transition-colors"
                >
                  <X size={20} />
                </button>
              </div>
              
              <div className="p-8">
                <div className="mb-8 p-6 bg-white/5 rounded-2xl border border-white/5">
                  <h3 className="text-cadmium-red font-bold uppercase tracking-widest text-xs mb-4 flex items-center gap-2">
                    <FileCode size={16} />
                    Game Stripper (EXPERIMENTAL)
                  </h3>
                  <p className="text-[10px] text-white/70 leading-relaxed mb-4">
                    Attempts to remove ads and analytics from the selected game file to conserve storage.
                  </p>
                  
                  <div className="flex gap-2">
                    <select 
                      className="flex-1 bg-cadmium-dark/40 border border-white/10 rounded-xl px-4 py-2 text-xs font-mono outline-none focus:border-cadmium-red/50 transition-colors"
                      onChange={(e) => setStrippingGame(e.target.value)}
                      value={strippingGame || ""}
                    >
                      <option value="">Select Game...</option>
                      {games.map(g => (
                        <option key={g.id} value={g.id}>{g.name}</option>
                      ))}
                    </select>
                    <button 
                      disabled={!strippingGame}
                      onClick={() => {
                        if (strippingGame) {
                          workerRef.current?.postMessage({ type: 'STRIP_GAME', payload: { gameId: strippingGame } });
                        }
                      }}
                      className={`px-4 py-2 rounded-xl font-bold text-[10px] uppercase tracking-widest transition-all ${
                        strippingGame ? 'bg-cadmium-red text-white hover:bg-cadmium-orange' : 'bg-white/5 text-white/20'
                      }`}
                    >
                      Strip
                    </button>
                  </div>
                </div>

                <div className="bg-cadmium-red/10 border border-cadmium-red/20 rounded-2xl p-6 mb-6">
                  <h3 className="text-cadmium-red font-bold uppercase tracking-widest text-xs mb-2">Nuclear Storage Purge</h3>
                  <p className="text-[10px] text-cadmium-red/80 leading-relaxed mb-4">
                    This action will permanently delete ALL games and ALL save data stored in the Cadmium VFS. This cannot be undone.
                  </p>
                  
                  <div className="space-y-4">
                    <div className="flex items-center justify-between bg-cadmium-dark/40 p-3 rounded-xl border border-white/5">
                      <span className="text-[10px] font-mono text-white/70 uppercase tracking-widest">Confirmation Code:</span>
                      <span className="text-sm font-mono font-bold text-white tracking-[0.3em]">{purgeTarget}</span>
                    </div>
                    
                    <input 
                      type="text"
                      value={purgeConfirmation}
                      onChange={(e) => setPurgeConfirmation(e.target.value.toUpperCase())}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && purgeConfirmation === purgeTarget) {
                          workerRef.current?.postMessage({ type: 'CLEAR_ALL' });
                          setShowGlobalSettings(false);
                        }
                      }}
                      placeholder="TYPE CODE TO CONFIRM"
                      className="w-full bg-cadmium-dark/40 border border-white/10 rounded-xl px-4 py-3 text-center font-mono text-sm tracking-widest focus:border-cadmium-red/50 outline-none transition-colors"
                    />
                    
                    <button 
                      disabled={purgeConfirmation !== purgeTarget}
                      onClick={() => {
                        workerRef.current?.postMessage({ type: 'CLEAR_ALL' });
                        setShowGlobalSettings(false);
                      }}
                      className={`w-full py-4 rounded-xl font-black text-xs uppercase tracking-[0.2em] transition-all ${
                        purgeConfirmation === purgeTarget 
                          ? 'bg-cadmium-red text-white shadow-lg shadow-cadmium-red/40 hover:scale-[1.02] active:scale-95' 
                          : 'bg-white/5 text-white/20 cursor-not-allowed'
                      }`}
                    >
                      Execute Nuclear Purge
                    </button>
                  </div>
                </div>

                <div className="space-y-4 mb-8">
                  <button 
                    onClick={() => window.location.reload()}
                    className="w-full flex items-center justify-between p-4 bg-white/5 hover:bg-white/10 rounded-2xl border border-white/5 transition-all group"
                  >
                    <div className="flex items-center gap-3">
                      <Layers size={18} className="text-white/40 group-hover:text-white transition-colors" />
                      <span className="text-xs font-bold uppercase tracking-wider">Reload Shell</span>
                    </div>
                    <span className="text-[10px] font-mono text-white/20">FORCE REFRESH</span>
                  </button>
                </div>

                <div className="flex items-center justify-between text-[10px] font-mono text-white/20 uppercase tracking-widest px-2">
                  <span>Cadmium Shell v{APP_VERSION}</span>
                  <span>Build: 20260401</span>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      {/* Delete Confirmation Modal */}
      <AnimatePresence>
        {deleteTarget && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[70] bg-cadmium-dark/80 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-cadmium-dark border border-white/10 rounded-[2rem] w-full max-w-sm overflow-hidden shadow-2xl"
            >
              <div className="p-8 text-center">
                <div className="w-16 h-16 bg-cadmium-red/10 rounded-full flex items-center justify-center mx-auto mb-6">
                  <Trash2 className="text-cadmium-red" size={32} />
                </div>
                <h2 className="text-xl font-bold mb-2 uppercase tracking-wider">Delete Game?</h2>
                <p className="text-xs text-white/70 font-mono uppercase tracking-widest mb-8">
                  This will permanently remove <span className="text-white">{deleteTarget}</span> and all its data.
                </p>
                
                <div className="flex gap-3">
                  <button 
                    onClick={() => setDeleteTarget(null)}
                    className="flex-1 py-4 bg-white/5 hover:bg-white/10 rounded-xl font-bold text-[10px] uppercase tracking-[0.2em] transition-all"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={confirmDelete}
                    className="flex-1 py-4 bg-cadmium-red hover:bg-cadmium-orange text-white rounded-xl font-black text-[10px] uppercase tracking-[0.2em] transition-all shadow-lg shadow-cadmium-red/40"
                  >
                    Confirm Delete
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Rename Modal */}
      <AnimatePresence>
        {renameTarget && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[70] bg-cadmium-dark/80 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.9, y: 20 }}
              className="bg-cadmium-dark border border-white/10 rounded-[2rem] w-full max-w-sm overflow-hidden shadow-2xl"
            >
              <div className="p-8">
                <div className="w-16 h-16 bg-cadmium-red/10 rounded-full flex items-center justify-center mx-auto mb-6">
                  <Layers className="text-cadmium-red" size={32} />
                </div>
                <h2 className="text-xl font-bold mb-2 uppercase tracking-wider text-center">Rename Game</h2>
                <p className="text-[10px] text-white/70 font-mono uppercase tracking-widest mb-6 text-center">
                  Update display name for <span className="text-white">{renameTarget}</span>
                </p>
                
                <input 
                  type="text"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  placeholder="New Game Name"
                  className="w-full bg-cadmium-dark/40 border border-white/10 rounded-xl px-4 py-3 font-mono text-sm tracking-widest focus:border-cadmium-red/50 outline-none transition-colors mb-6"
                />

                <div className="flex gap-3">
                  <button 
                    onClick={() => setRenameTarget(null)}
                    className="flex-1 py-4 bg-white/5 hover:bg-white/10 rounded-xl font-bold text-[10px] uppercase tracking-[0.2em] transition-all"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={() => {
                      if (renameValue.trim()) {
                        workerRef.current?.postMessage({ 
                          type: 'RENAME_GAME', 
                          payload: { oldId: renameTarget, newId: renameValue.trim() } 
                        });
                        setRenameTarget(null);
                      }
                    }}
                    className="flex-1 py-4 bg-cadmium-red hover:bg-cadmium-orange text-white rounded-xl font-black text-[10px] uppercase tracking-[0.2em] transition-all shadow-lg shadow-cadmium-red/40"
                  >
                    Save Name
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
