/**
 * Service Worker for high-performance request interception.
 * Serves game assets directly from the Origin Private File System (OPFS).
 */

const CACHE_NAME = "cadmium-shell-v4";
const SANDBOX_PATH = "/vfs/";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      // Clear old caches
      caches.keys().then((keys) => {
        return Promise.all(
          keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
        );
      }),
    ])
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Intercept requests to our local virtual file system path
  if (url.pathname.startsWith(SANDBOX_PATH)) {
    event.respondWith(handleGameAssetRequest(url));
    return;
  }

  // Network-first strategy for the shell itself
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => {
        return caches.match(event.request);
      })
  );
});

async function handleGameAssetRequest(url) {
  try {
    // Path format: /vfs/gameId/path/to/asset
    const relativePath = url.pathname.slice(SANDBOX_PATH.length);
    const pathParts = relativePath.split("/").filter(Boolean);
    
    if (pathParts.length < 1) {
      return new Response("Invalid VFS path", { status: 400 });
    }

    const gameId = decodeURIComponent(pathParts[0]);
    const filePath = decodeURIComponent(pathParts.slice(1).join("/") || "index.html");

    const root = await navigator.storage.getDirectory();
    // New structure: /{gameId}/www/{filePath}
    let gameDir;
    try {
      gameDir = await root.getDirectoryHandle(gameId);
    } catch (e) {
      return new Response(`Game directory not found: ${gameId}`, { status: 404 });
    }

    let wwwDir;
    try {
      wwwDir = await gameDir.getDirectoryHandle("www");
    } catch (e) {
      return new Response(`Assets directory (www) not found for game: ${gameId}`, { status: 404 });
    }

    let current = wwwDir;
    const subPaths = filePath.split("/");
    for (let i = 0; i < subPaths.length - 1; i++) {
      try {
        current = await current.getDirectoryHandle(subPaths[i]);
      } catch (e) {
        return new Response(`Directory not found: ${subPaths[i]} in path ${filePath}`, { status: 404 });
      }
    }

    let fileHandle;
    try {
      fileHandle = await current.getFileHandle(subPaths[subPaths.length - 1]);
    } catch (e) {
      return new Response(`File not found: ${subPaths[subPaths.length - 1]} in path ${filePath}`, { status: 404 });
    }
    const file = await fileHandle.getFile();

    // Determine MIME type
    let contentType = file.type;
    if (!contentType) {
      const ext = filePath.split('.').pop().toLowerCase();
      const mimeMap = {
        'js': 'application/javascript',
        'wasm': 'application/wasm',
        'html': 'text/html',
        'css': 'text/css',
        'json': 'application/json',
        'png': 'image/png',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'svg': 'image/svg+xml',
        'data': 'application/octet-stream',
        'txt': 'text/plain',
        'mp3': 'audio/mpeg',
        'wav': 'audio/wav',
        'ogg': 'audio/ogg',
        'mp4': 'video/mp4'
      };
      contentType = mimeMap[ext] || 'application/octet-stream';
    }

    return new Response(file, {
      headers: {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
        "Cross-Origin-Resource-Policy": "cross-origin",
        "X-Content-Type-Options": "nosniff",
        // These help with SharedArrayBuffer and other advanced APIs
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Opener-Policy": "same-origin"
      },
    });
  } catch (error) {
    return new Response(`Asset not found in VFS: ${url.pathname}`, { 
      status: 404,
      headers: { "Content-Type": "text/plain" }
    });
  }
}
