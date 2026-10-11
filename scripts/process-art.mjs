// Turns the supplied banner + app icon art into the files the PWA uses.
// usage: node scripts/process-art.mjs <banner.webp> <icon.webp>
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
let sharp;
try { sharp = require('sharp'); } catch { sharp = require(path.resolve('..', 'kings', 'node_modules', 'sharp')); }

const [bannerSrc, iconSrc] = process.argv.slice(2);

// Landing-page title banner (2000x772) -> 1000px wide, still sharp on 3x phones at ~94vw
await sharp(bannerSrc).resize({ width: 1000 }).jpeg({ quality: 86, mozjpeg: true }).toFile('public/banner.jpg');

// App icon: the source is a rounded square sitting on black. Trim that frame off.
const meta = await sharp(iconSrc).metadata();
const m = Math.round(meta.width * 0.035);
const inner = await sharp(iconSrc).extract({ left: m, top: m, width: meta.width - 2 * m, height: meta.height - 2 * m }).toBuffer();
for (const [size, name] of [[192, 'icon-192.png'], [512, 'icon-512.png'], [180, 'apple-touch-icon.png']]) {
  await sharp(inner).resize(size, size).png().toFile(`public/icons/${name}`);
}
// Maskable: Android crops to a circle/squircle, keeping the central ~80%. Shrink the art into
// that safe zone over a blurred copy of itself so nothing important is clipped.
const bg = await sharp(inner).resize(512, 512).blur(24).toBuffer();
const fg = await sharp(inner).resize(410, 410).toBuffer();
await sharp(bg).composite([{ input: fg, gravity: 'centre' }]).png().toFile('public/icons/icon-maskable-512.png');
console.log('art processed');
