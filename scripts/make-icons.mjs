// Draws the app icon as SVG and rasterizes it. Needs `sharp` (resolved from ../kings/node_modules if not installed here).
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
let sharp;
try { sharp = require('sharp'); } catch { sharp = require(path.resolve('..', 'kings', 'node_modules', 'sharp')); }

const svg = (pad) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#14597f"/><stop offset="1" stop-color="#071c2e"/></linearGradient>
    <linearGradient id="hull" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a8702f"/><stop offset="1" stop-color="#5e3a18"/></linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#sky)"/>
  <g transform="translate(256 256) scale(${1 - pad}) translate(-256 -256)">
    <circle cx="380" cy="130" r="46" fill="#f2c14e" opacity=".95"/>
    <rect x="248" y="110" width="10" height="250" fill="#3a230d"/>
    <path d="M258 120 L398 300 L258 300 Z" fill="#f3e3bd"/>
    <path d="M248 140 L130 300 L248 300 Z" fill="#e0cf9f"/>
    <path d="M258 110 L318 128 L258 146 Z" fill="#e5533d"/>
    <path d="M96 330 H416 L372 408 Q256 430 140 408 Z" fill="url(#hull)" stroke="#2d1d08" stroke-width="6"/>
    <path d="M0 400 Q64 372 128 400 T256 400 T384 400 T512 400 V512 H0 Z" fill="#0d3b5c"/>
    <path d="M0 440 Q64 414 128 440 T256 440 T384 440 T512 440 V512 H0 Z" fill="#071c2e"/>
    <g stroke="#f2c14e" stroke-width="12" stroke-linecap="round"><path d="M410 440 l36 36 M446 440 l-36 36"/></g>
  </g>
</svg>`;

const out = 'public/icons';
await sharp(Buffer.from(svg(0.0))).resize(192, 192).png().toFile(`${out}/icon-192.png`);
await sharp(Buffer.from(svg(0.0))).resize(512, 512).png().toFile(`${out}/icon-512.png`);
await sharp(Buffer.from(svg(0.14))).resize(512, 512).png().toFile(`${out}/icon-maskable-512.png`);
console.log('icons written');
