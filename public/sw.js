/**
 * Service Worker for high-performance request interception.
 * Serves game assets directly from the Origin Private File System (OPFS).
 */

const CACHE_NAME = "cadmium-shell-v6";
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
    event.respondWith(handleGameAssetRequest(url, event.request));
    return;
  }

  // Only intercept and cache GET requests to our own origin (App Shell)
  if (url.origin === self.location.origin && event.request.method === 'GET') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Don't cache partial responses or errors
          if (response.ok && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => {
          return caches.match(event.request);
        })
    );
    return;
  }

  // For all other requests (external APIs, CDNs, large game downloads),
  // let the browser handle them natively without Service Worker interference.
  return;
});

async function handleGameAssetRequest(url, request) {
  try {
    // Path format: /vfs/gameId/path/to/asset
    const relativePath = url.pathname.slice(SANDBOX_PATH.length);
    const pathParts = relativePath.split("/").filter(Boolean);
    
    if (pathParts.length < 1) {
      return new Response("Invalid VFS path", { status: 400 });
    }

    const gameId = decodeURIComponent(pathParts[0]);
    const filePath = decodeURIComponent(pathParts.slice(1).join("/") || "index.html");
    const subPaths = filePath.split("/");

    const root = await navigator.storage.getDirectory();
    
    let gameDir;
    try {
      gameDir = await root.getDirectoryHandle(gameId);
    } catch (e) {
      return new Response(`Game directory not found: ${gameId}`, { status: 404 });
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

    const reqHeaders = request.headers;
    const rangeHeader = reqHeaders.get('Range');

    if (rangeHeader) {
      const bytesMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (bytesMatch) {
        const start = parseInt(bytesMatch[1], 10);
        const end = bytesMatch[2] ? parseInt(bytesMatch[2], 10) : file.size - 1;
        const chunkSize = end - start + 1;
        const slicedFile = file.slice(start, end + 1, contentType);

        return new Response(slicedFile, {
          status: 206,
          headers: {
            "Content-Type": contentType,
            "Content-Range": `bytes ${start}-${end}/${file.size}`,
            "Content-Length": chunkSize.toString(),
            "Accept-Ranges": "bytes",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "public, max-age=3600",
            "Cross-Origin-Resource-Policy": "cross-origin",
            "X-Content-Type-Options": "nosniff",
            "Cross-Origin-Embedder-Policy": "credentialless",
            "Cross-Origin-Opener-Policy": "same-origin"
          }
        });
      }
    }

    return new Response(file, {
      headers: {
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600",
        "Cross-Origin-Resource-Policy": "cross-origin",
        "X-Content-Type-Options": "nosniff",
        // These help with SharedArrayBuffer and other advanced APIs
        "Cross-Origin-Embedder-Policy": "credentialless",
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
