import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { NetworkFirst } from 'workbox-strategies';

/**
 * Service Worker for high-performance request interception.
 * Serves game assets directly from the Origin Private File System (OPFS).
 */

const CACHE_NAME = "cadmium-shell-v10";
const SW_BASE = self.location.pathname.substring(0, self.location.pathname.lastIndexOf('/') + 1);
const SANDBOX_PATH = SW_BASE + "vfs/";

// ─── FETCH HANDLER ────────────────────────────────────────────────────────────
// CRITICAL: Must be registered BEFORE precacheAndRoute() is called below.
// Workbox registers its own fetch handler inside precacheAndRoute(), which
// intercepts navigate requests first and serves cached HTML without headers.
// Our handler must run first to inject COOP/COEP on the document response.
// SharedArrayBuffer (required by Unity WebGL threading) only works when
// crossOriginIsolated=true, which requires these headers on the main document.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // 1. COOP/COEP on all navigate requests (shell + game iframes)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then(response => {
        const headers = new Headers(response.headers);
        headers.set('Cross-Origin-Opener-Policy', 'same-origin');
        headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
        headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers
        });
      }).catch(() => fetch(event.request))
    );
    return;
  }

  // 2. WASM MIME type fix — CDN serves .wasm without application/wasm type
  // causing fallback to ArrayBuffer instantiation which crashes at 800MB+
  if (event.request.url.endsWith('.wasm') || event.request.url.includes('.wasm?')) {
    event.respondWith(
      fetch(event.request).then(response => {
        const headers = new Headers(response.headers);
        headers.set('Content-Type', 'application/wasm');
        headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      })
    );
    return;
  }

  // 3. VFS game asset requests
  if (url.pathname.startsWith(SANDBOX_PATH)) {
    event.respondWith(handleGameAssetRequest(url, event.request));
    return;
  }
});

// Precache Vite build assets — intentionally AFTER our fetch handler above
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST || []);

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((keys) => {
        return Promise.all(
          keys.filter((key) => key !== CACHE_NAME && !key.includes('workbox')).map((key) => caches.delete(key))
        );
      }),
    ])
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

registerRoute(
  ({ url, request }) => url.origin === self.location.origin && request.method === 'GET' && !url.pathname.startsWith(SANDBOX_PATH),
  new NetworkFirst({ cacheName: CACHE_NAME })
);

async function handleGameAssetRequest(url, request) {
  try {
    if (request.headers.get('Service-Worker') === 'script' || url.pathname.endsWith('sw.js') || url.pathname.endsWith('ServiceWorker.js')) {
      return new Response("Game Service Workers are disabled in Cadmium", { 
        status: 404,
        headers: { "Content-Type": "text/plain" }
      });
    }

    const relativePath = url.pathname.slice(SANDBOX_PATH.length);
    const pathParts = relativePath.split("/").filter(Boolean);
    if (pathParts.length < 1) return new Response("Invalid VFS path", { status: 400 });

    const gameId = decodeURIComponent(pathParts[0]);
    const filePath = decodeURIComponent(pathParts.slice(1).join("/") || "index.html");
    const subPaths = filePath.split("/");

    const root = await navigator.storage.getDirectory();
    if (!root) return new Response("OPFS Root unavailable", { status: 500 });

    let cadmiumGamesDir;
    try {
      cadmiumGamesDir = await root.getDirectoryHandle("cadmium_games");
    } catch (e) {
      return new Response("cadmium_games directory not found", { status: 404 });
    }

    let gameDir;
    let retryCount = 0;
    const maxRetries = 3;
    const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]/gi, '_').replace(/^_+|_+$/g, '');
    const normalizedGameId = slugify(gameId);

    while (retryCount < maxRetries) {
      try {
        gameDir = await cadmiumGamesDir.getDirectoryHandle(gameId);
        break;
      } catch (e) {
        let found = false;
        const available = [];
        try {
          for await (const [name, handle] of cadmiumGamesDir.entries()) {
            available.push(`${name} (${handle.kind})`);
            const normalizedName = slugify(name);
            if (handle.kind === 'directory' && (
              name.toLowerCase() === gameId.toLowerCase() ||
              normalizedName === normalizedGameId ||
              name === gameId + '.html' ||
              name + '.html' === gameId ||
              name.replace(/\s+/g, '_') === gameId.replace(/\s+/g, '_')
            )) {
              gameDir = handle;
              found = true;
              break;
            }
          }
        } catch (entriesError) {
          console.error("[SW] Error listing entries:", entriesError);
        }
        if (found) break;
        retryCount++;
        if (retryCount < maxRetries) {
          await new Promise(r => setTimeout(r, 200 * retryCount));
        } else {
          return new Response(`Game directory not found: "${gameId}". Available: [${available.join(", ")}]`, { 
            status: 404, headers: { "Content-Type": "text/plain" }
          });
        }
      }
    }

    let current;
    try {
      current = await gameDir.getDirectoryHandle("www");
    } catch (e) {
      return new Response(`Assets directory (www) not found for game: ${gameId}`, { status: 404 });
    }

    for (let i = 0; i < subPaths.length - 1; i++) {
      try {
        current = await current.getDirectoryHandle(subPaths[i]);
      } catch (e) {
        return new Response(`Directory not found: ${subPaths[i]}`, { status: 404 });
      }
    }

    let fileHandle;
    try {
      fileHandle = await current.getFileHandle(subPaths[subPaths.length - 1]);
    } catch (e) {
      return new Response(`File not found: ${subPaths[subPaths.length - 1]}`, { status: 404 });
    }
    const file = await fileHandle.getFile();

    let contentType = file.type;
    if (!contentType) {
      const ext = filePath.split('.').pop().toLowerCase();
      const mimeMap = {
        'js': 'application/javascript', 'wasm': 'application/wasm',
        'html': 'text/html', 'css': 'text/css', 'json': 'application/json',
        'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
        'svg': 'image/svg+xml', 'data': 'application/octet-stream',
        'txt': 'text/plain', 'mp3': 'audio/mpeg', 'wav': 'audio/wav',
        'ogg': 'audio/ogg', 'mp4': 'video/mp4'
      };
      contentType = mimeMap[ext] || 'application/octet-stream';
    }

    const CORS_HEADERS = {
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Cache-Control": "public, max-age=3600"
    };

    const rangeHeader = request.headers.get('Range');
    if (rangeHeader) {
      const bytesMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (bytesMatch) {
        const start = parseInt(bytesMatch[1], 10);
        const end = bytesMatch[2] ? parseInt(bytesMatch[2], 10) : file.size - 1;
        return new Response(file.slice(start, end + 1, contentType), {
          status: 206,
          headers: {
            "Content-Type": contentType,
            "Content-Range": `bytes ${start}-${end}/${file.size}`,
            "Content-Length": String(end - start + 1),
            "Accept-Ranges": "bytes",
            ...CORS_HEADERS
          }
        });
      }
    }

    return new Response(file, {
      headers: { "Content-Type": contentType, "Accept-Ranges": "bytes", ...CORS_HEADERS }
    });
  } catch (error) {
    return new Response(`Asset not found in VFS: ${url.pathname}`, { 
      status: 404, headers: { "Content-Type": "text/plain" }
    });
  }
}
