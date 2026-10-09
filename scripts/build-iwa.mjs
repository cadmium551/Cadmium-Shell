// Usage: npm run build:iwa
// 1) vite build  ->  dist/
// 2) pack dist/ into a Web Bundle, sign it with key.pem  ->  cadmium-shell.swbn
import fs from 'node:fs';
import path from 'node:path';
import * as wbn from 'wbn';
import * as wbnSign from 'wbn-sign';

const KEY_PATH = process.env.IWA_KEY || './key.pem';
const DIST = './dist';
const OUT = './cadmium-shell.swbn';

if (!fs.existsSync(KEY_PATH)) {
  console.error(`Missing ${KEY_PATH}. Create one with:\n  openssl genpkey -algorithm Ed25519 -out key.pem`);
  process.exit(1);
}
const privateKey = wbnSign.parsePemKey(fs.readFileSync(KEY_PATH, 'utf-8'));
const bundleId = new wbnSign.WebBundleId(privateKey).serialize();
const origin = `isolated-app://${bundleId}`;
console.log('Web Bundle ID :', bundleId);
console.log('App origin    :', origin);

const CSP = [
  "base-uri 'none'",
  "default-src 'self'",
  "object-src 'none'",
  "frame-src 'self' https: blob: data:",
  "connect-src 'self' https: wss: blob: data:",
  "script-src 'self' 'wasm-unsafe-eval'",
  "img-src 'self' https: blob: data:",
  "media-src 'self' https: blob: data:",
  "font-src 'self' blob: data:",
  "style-src 'self' 'unsafe-inline'",
  "worker-src 'self' blob:",
  "require-trusted-types-for 'script'",
].join('; ');

const MIME = {
  html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', css: 'text/css',
  json: 'application/json', webmanifest: 'application/manifest+json', svg: 'image/svg+xml',
  png: 'image/png', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
  txt: 'text/plain', wasm: 'application/wasm', map: 'application/json',
};

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

const builder = new wbn.BundleBuilder('b2');
builder.setPrimaryURL(`${origin}/`);

const headersFor = (type) => ({
  'Content-Type': type,
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': CSP,
});

for (const file of walk(DIST)) {
  const rel = path.relative(DIST, file).split(path.sep).join('/');
  if (rel === '_headers' || rel === '_redirects') continue; // Cloudflare/Netlify-only files
  const ext = rel.split('.').pop();
  const type = MIME[ext] || 'application/octet-stream';
  const body = fs.readFileSync(file);
  builder.addExchange(`${origin}/${rel}`, 200, headersFor(type), body);
  if (rel === 'index.html') builder.addExchange(`${origin}/`, 200, headersFor(type), body);
  console.log('  +', rel);
}

const unsigned = Buffer.from(builder.createBundle());
const signed = await wbnSign.SignedWebBundle.fromWebBundle(unsigned, [
  new wbnSign.NodeCryptoSigningStrategy(privateKey),
]);
fs.writeFileSync(OUT, signed.getSignedWebBundleBytes());
console.log(`\nWrote ${OUT} (${fs.statSync(OUT).size} bytes)`);
