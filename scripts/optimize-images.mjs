// Generuje optimalizované obrázky pre web zo zdrojových (vysoké rozlíšenie)
// súborov v `assets-src/`. Originály sa nikdy neservírujú priamo — boli
// niekoľko MB veľké (napr. logo v hlavičke 2,5 MB pre 38px prvok).
//
// Spustenie:  npm run build:images
//
// Pre každý maskot vytvorí zmenšenú PNG (fallback) + WebP. Veľký hero navyše
// dostane AVIF a responzívny 640 px variant, aby sa neposielali zbytočné dáta.

import sharp from "sharp";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, stat } from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "assets-src");
const OUT_MASCOT = path.join(ROOT, "public", "assets", "mascot");

// Cieľové šírky vychádzajú zo skutočnej zobrazovanej veľkosti × ~2 (retina).
//   brand-mark sa zobrazuje 42px, hero max 640px, cta max-height 150px.
const MASCOTS = [
  { name: "bear-head-mark", size: 128, webp: false },               // logo v hlavičke
  { name: "bear-map-mascot-transparent", size: 700, webp: true },   // hero (above-the-fold)
  {
    name: "bear-hero-roaring",
    size: 1200,
    webp: true,
    avif: true,
    responsiveWidths: [640],
  },                                                                // hero detail, cropped bottom-right
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

  for (const { name, size, webp, avif = false, responsiveWidths = [] } of MASCOTS) {
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

    if (avif) {
      const avifOut = path.join(OUT_MASCOT, `${name}.avif`);
      await sharp(src)
        .resize(size, size, { fit: "inside", withoutEnlargement: true })
        .avif({ quality: 58, effort: 6 })
        .toFile(avifOut);
      console.log(`  ${name}.avif -> ${await fileSize(avifOut)}`);
    }

    for (const width of responsiveWidths) {
      const variantName = `${name}-${width}`;
      const variantPngOut = path.join(OUT_MASCOT, `${variantName}.png`);

      await sharp(src)
        .resize({ width, withoutEnlargement: true })
        .png({ compressionLevel: 9, palette: true, quality: 90, effort: 10 })
        .toFile(variantPngOut);
      console.log(`  ${variantName}.png -> ${await fileSize(variantPngOut)}`);

      if (webp) {
        const variantWebpOut = path.join(OUT_MASCOT, `${variantName}.webp`);
        await sharp(src)
          .resize({ width, withoutEnlargement: true })
          .webp({ quality: 82, effort: 6 })
          .toFile(variantWebpOut);
        console.log(`  ${variantName}.webp -> ${await fileSize(variantWebpOut)}`);
      }

      if (avif) {
        const variantAvifOut = path.join(OUT_MASCOT, `${variantName}.avif`);
        await sharp(src)
          .resize({ width, withoutEnlargement: true })
          .avif({ quality: 58, effort: 6 })
          .toFile(variantAvifOut);
        console.log(`  ${variantName}.avif -> ${await fileSize(variantAvifOut)}`);
      }
    }
  }
}

async function buildDarkLogo() {
  const src = path.join(SRC, "mascot", "bear-head-mark.png");
  const out = path.join(OUT_MASCOT, "bear-head-mark-dark.png");
  const image = sharp(src).resize(128, 128, { fit: "inside", withoutEnlargement: true }).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const white = [0xf1, 0xf0, 0xe8];
  const mutedWhite = [0xb2, 0xb1, 0xa6];

  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i + 3] === 0) continue;

    const luminance = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    const target = luminance > 105 ? mutedWhite : white;
    data[i] = target[0];
    data[i + 1] = target[1];
    data[i + 2] = target[2];
  }

  await sharp(data, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  })
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log(`  bear-head-mark-dark.png -> ${await fileSize(out)}`);
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
await buildDarkLogo();
await buildFavicon();
console.log("Hotovo.");
