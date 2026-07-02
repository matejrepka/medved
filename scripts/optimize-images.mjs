// Generuje optimalizované obrázky pre web zo zdrojových (vysoké rozlíšenie)
// súborov v `assets-src/`. Originály sa nikdy neservírujú priamo — boli
// niekoľko MB veľké (napr. logo v hlavičke 2,5 MB pre 38px prvok).
//
// Spustenie:  npm run build:images
//
// Pre každý maskot vytvorí zmenšenú PNG (fallback) + WebP (moderné prehliadače).

import sharp from "sharp";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, stat } from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "assets-src");
const OUT_MASCOT = path.join(ROOT, "public", "assets", "mascot");

// Cieľové šírky vychádzajú zo skutočnej zobrazovanej veľkosti × ~2 (retina).
//   brand-mark sa zobrazuje 38px, hero max 340px, cta max-height 150px.
const MASCOTS = [
  { name: "bear-head-mark", size: 128, webp: false },               // logo v hlavičke
  { name: "bear-map-mascot-transparent", size: 700, webp: true },   // hero (above-the-fold)
  { name: "bear-helper", size: 460, webp: true },                   // CTA "Videli ste medveda?"
];

async function fileSize(p) {
  try {
    return ((await stat(p)).size / 1024).toFixed(1) + " KB";
  } catch {
    return "—";
  }
}

async function buildMascots() {
  await mkdir(OUT_MASCOT, { recursive: true });

  for (const { name, size, webp } of MASCOTS) {
    const src = path.join(SRC, "mascot", `${name}.png`);
    const pngOut = path.join(OUT_MASCOT, `${name}.png`);

    await sharp(src)
      .resize(size, size, { fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 9, palette: true, quality: 90, effort: 10 })
      .toFile(pngOut);
    console.log(`  ${name}.png  -> ${await fileSize(pngOut)}`);

    if (webp) {
      const webpOut = path.join(OUT_MASCOT, `${name}.webp`);
      await sharp(src)
        .resize(size, size, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82, effort: 6 })
        .toFile(webpOut);
      console.log(`  ${name}.webp -> ${await fileSize(webpOut)}`);
    }
  }
}

async function buildFavicon() {
  const src = path.join(SRC, "mascot", "bear-head-mark.png");
  const out = path.join(ROOT, "public", "favicon.png");
  await sharp(src)
    .resize(256, 256, { fit: "inside" })
    .png({ compressionLevel: 9, palette: true, quality: 90, effort: 10 })
    .toFile(out);
  console.log(`  favicon.png -> ${await fileSize(out)}`);
}

console.log("Optimalizujem obrázky…");
await buildMascots();
await buildFavicon();
console.log("Hotovo.");
