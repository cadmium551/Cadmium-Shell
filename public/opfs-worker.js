/**
 * OPFS Worker for high-performance file operations and game saves.
 */

self.onmessage = async (e) => {
  const { type, payload } = e.data;

  try {
    const root = await navigator.storage.getDirectory();
    if (!root) throw new Error("OPFS Root unavailable");

    switch (type) {
      case "WRITE_FILES": {
        const { gameId, files } = payload;
        // New structure: /{gameId}/www/
        const gameDir = await root.getDirectoryHandle(gameId, { create: true });
        const wwwDir = await gameDir.getDirectoryHandle("www", { create: true });

        for (const file of files) {
          const pathParts = file.path.split("/");
          let currentDir = wwwDir;

          for (let i = 0; i < pathParts.length - 1; i++) {
            currentDir = await currentDir.getDirectoryHandle(pathParts[i], { create: true });
          }

          const fileHandle = await currentDir.getFileHandle(pathParts[pathParts.length - 1], { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(file.content);
          await writable.close();
        }
        self.postMessage({ type: "WRITE_SUCCESS", gameId });
        break;
      }

      case "LIST_GAMES": {
        const games = [];
        for await (const [name, handle] of root.entries()) {
          // Only list directories that aren't the legacy "games" or "saves" folders
          if (handle.kind === "directory" && name !== "games" && name !== "saves") {
            let displayName = name;
            try {
              const metaHandle = await handle.getFileHandle("metadata.json");
              const file = await metaHandle.getFile();
              const text = await file.text();
              const meta = JSON.parse(text);
              if (meta.name) displayName = meta.name;
            } catch (e) {
              // Metadata doesn't exist or is invalid, fallback to directory name
            }
            games.push({ id: name, name: displayName });
          }
        }
        self.postMessage({ type: "LIST_SUCCESS", games, gameId: "LIST" });
        break;
      }

      case "DELETE_GAME": {
        const { gameId } = payload;
        console.log(`[Worker] Purging game directory: ${gameId}`);
        // Deleting the root game folder deletes assets AND data/saves
        await root.removeEntry(gameId, { recursive: true });
        self.postMessage({ type: "DELETE_SUCCESS", gameId });
        break;
      }

      case "CLEAR_ALL": {
        console.log("[Worker] Nuclear purge of all OPFS storage");
        for await (const [name, handle] of root.entries()) {
          await root.removeEntry(name, { recursive: true });
        }
        self.postMessage({ type: "DELETE_SUCCESS", gameId: "ALL" });
        break;
      }

      case "SAVE_GAME_DATA": {
        const { gameId, data } = payload;
        // Store saves inside the game folder: /{gameId}/data/
        const gameDir = await root.getDirectoryHandle(gameId, { create: true });
        const dataDir = await gameDir.getDirectoryHandle("data", { create: true });
        const fileHandle = await dataDir.getFileHandle("save.json", { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(JSON.stringify(data));
        await writable.close();
        self.postMessage({ type: "SAVE_SUCCESS", gameId });
        break;
      }

      case "LOAD_GAME_DATA": {
        const { gameId } = payload;
        try {
          const gameDir = await root.getDirectoryHandle(gameId);
          const dataDir = await gameDir.getDirectoryHandle("data");
          const fileHandle = await dataDir.getFileHandle("save.json");
          const file = await fileHandle.getFile();
          const text = await file.text();
          self.postMessage({ type: "LOAD_SUCCESS", gameId, data: JSON.parse(text) });
        } catch (e) {
          self.postMessage({ type: "LOAD_SUCCESS", gameId, data: null });
        }
        break;
      }

      case "STRIP_GAME": {
        const { gameId } = payload;
        try {
          const gameDir = await root.getDirectoryHandle(gameId);
          const wwwDir = await gameDir.getDirectoryHandle("www");
          const fileHandle = await wwwDir.getFileHandle("index.html");
          const file = await fileHandle.getFile();
          let text = await file.text();

          console.log(`[Worker] Stripping ads/analytics from ${gameId}`);
          
          // Removal patterns
          const patterns = [
            // 1. Remove Google Analytics / Tag Manager
            /<script\b[^>]*src=["']https?:\/\/(?:www\.)?googletagmanager\.com\/gtag\/js[^"']*["'][^>]*><\/script>/gi,
            /<script\b[^>]*src=["']https?:\/\/(?:www\.)?google-analytics\.com\/analytics\.js[^"']*["'][^>]*><\/script>/gi,
            /<script\b[^>]*>[\s\S]*?gtag\(['"]config['"][\s\S]*?<\/script>/gi,
            /<script\b[^>]*>[\s\S]*?ga\(['"]create['"][\s\S]*?<\/script>/gi,
            // 3. Remove sidebar ads and their containers
            /<div\b[^>]*id=["']sidebarad[12]["'][^>]*>[\s\S]*?<\/div>/gi,
            // 4. Remove common ad iframes
            /<iframe\b[^>]*src=["']https?:\/\/(?:[^"']+\.)?(?:doubleclick\.net|adnxs\.com|googleads\.g\.doubleclick\.net|amazon-adsystem\.com|taboola\.com|outbrain\.com|popads\.net|propellerads\.com)[^"']*["'][^>]*><\/iframe>/gi,
            /<script\b[^>]*src=["']https?:\/\/(?:[^"']+\.)?(?:adsbygoogle\.js|carbonads\.com|buysellads\.com)[^"']*["'][^>]*><\/script>/gi,
            // 5. Remove obfuscated ad/tracking scripts (targets standard javascript-obfuscator array rotation)
            /<script>\s*\(\s*function\s*\(\s*_0x[a-fA-F0-9]+,\s*_0x[a-fA-F0-9]+\s*\)[\s\S]*?_0x[a-fA-F0-9]+\['push'\]\([\s\S]*?<\/script>/gi,
            /window\.ga=window\.ga\|\|function\(\)\{\(ga\.q=ga\.q\|\|\[\]\)\.push\(arguments\)\};ga\.l=\+new Date;/g
          ];

          let originalSize = text.length;
          patterns.forEach(p => {
            text = text.replace(p, "<!-- Cadmium Stripped -->");
          });

          const writable = await fileHandle.createWritable();
          await writable.write(text);
          await writable.close();

          self.postMessage({ 
            type: "STRIP_SUCCESS", 
            gameId, 
            savings: originalSize - text.length 
          });
        } catch (e) {
          self.postMessage({ type: "ERROR", error: `Stripping failed: ${e.message}`, gameId });
        }
        break;
      }

      case "RENAME_GAME": {
        const { oldId, newId } = payload;
        try {
          const gameDir = await root.getDirectoryHandle(oldId);
          
          // Instead of moving the directory (which breaks hardcoded paths in games),
          // we just save a metadata.json file with the new display name.
          const metaHandle = await gameDir.getFileHandle("metadata.json", { create: true });
          const writable = await metaHandle.createWritable();
          await writable.write(JSON.stringify({ name: newId }));
          await writable.close();

          self.postMessage({ type: "RENAME_SUCCESS", oldId, newId });
        } catch (e) {
          self.postMessage({ type: "ERROR", error: `Rename failed: ${e.message}`, gameId: oldId });
        }
        break;
      }

      case "LIST_FILES": {
        const { gameId } = payload;
        const files = [];
        try {
          const gameDir = await root.getDirectoryHandle(gameId);
          
          async function scan(dir, path = "") {
            for await (const [name, handle] of dir.entries()) {
              const fullPath = path ? `${path}/${name}` : name;
              if (handle.kind === "directory") {
                await scan(handle, fullPath);
              } else {
                files.push(fullPath);
              }
            }
          }
          await scan(gameDir);
          self.postMessage({ type: "LIST_FILES_SUCCESS", gameId, files });
        } catch (e) {
          self.postMessage({ type: "ERROR", error: `Failed to list files: ${e.message}`, gameId });
        }
        break;
      }
    }
  } catch (error) {
    // Try to extract gameId from payload if it exists
    const gameId = payload?.gameId || "unknown";
    self.postMessage({ type: "ERROR", error: error.message, gameId });
  }
};
