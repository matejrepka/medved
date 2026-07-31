import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pages = [
  "index.html",
  "domov.html",
  "stats.html",
  "nahlas.html",
  "bezpecnost.html",
  "o-mape.html",
  "spomenuli-nas.html",
  "privacy.html",
  "terms.html",
  "location.html",
];

const errors = [];
const titles = new Map();

for (const file of pages) {
  const html = await readFile(path.join(root, "public", file), "utf8");
  const title = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim();
  const description = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i)?.[1]?.trim();
  const h1Count = (html.match(/<h1(?:\s|>)/gi) || []).length;
  const images = html.match(/<img\b[^>]*>/gis) || [];

  if (!title) errors.push(`${file}: chýba title`);
  if (!description) errors.push(`${file}: chýba meta description`);
  if (h1Count !== 1) errors.push(`${file}: očakáva sa práve jedno h1, nájdené ${h1Count}`);
  if (!html.includes("<!-- SEO_HEAD -->")) errors.push(`${file}: chýba SEO_HEAD token`);
  for (const image of images) {
    if (!/\balt\s*=\s*["'][^"']+["']/i.test(image)) {
      errors.push(`${file}: obrázok nemá neprázdny alt atribút`);
    }
  }
  if (title) {
    if (titles.has(title)) errors.push(`${file}: duplicitný title s ${titles.get(title)}`);
    titles.set(title, file);
  }
}

const locationTemplate = await readFile(path.join(root, "public", "location.html"), "utf8");
if (!locationTemplate.includes("<!-- LOCATION_NAME -->")) {
  errors.push("location.html: chýba LOCATION_NAME token");
}

const manifest = JSON.parse(await readFile(path.join(root, "public", "manifest.webmanifest"), "utf8"));
if (manifest.lang !== "sk") errors.push("manifest.webmanifest: lang musí byť sk");

const server = await readFile(path.join(root, "server.js"), "utf8");
for (const route of ["/robots.txt", "/sitemap.xml", "/llms.txt", "/feed.xml"]) {
  if (!server.includes(`app.get(\"${route}\"`)) errors.push(`server.js: chýba route ${route}`);
}
if (!server.includes("LOCATION_ROUTE_PREFIX")) errors.push("server.js: chýbajú lokalitné SEO stránky");
if (!server.includes("notifyIndexNow")) errors.push("server.js: chýba IndexNow aktualizácia");
if (!server.includes('const CANONICAL_SITE_ORIGIN = "https://kdejemedved.sk"')) {
  errors.push("server.js: kanonický origin musí byť https://kdejemedved.sk");
}
if (!/if \(pathname === "\/domov"\) \{\s*graph\.push\(\{\s*"@type": "FAQPage"/m.test(server)) {
  errors.push("server.js: FAQ schema musí byť naviazaná na viditeľné FAQ na /domov");
}

const searchableFiles = await Promise.all([
  ...pages.map((file) => readFile(path.join(root, "public", file), "utf8")),
  readFile(path.join(root, "server.js"), "utf8"),
]);
if (searchableFiles.some((content) => /game\.medved\.sk/i.test(content))) {
  errors.push("verejné SEO súbory obsahujú neaktuálnu doménu game.medved.sk");
}

const home = await readFile(path.join(root, "public", "domov.html"), "utf8");
for (const target of ["/#sightingsHead", "/#newsHead"]) {
  if (!home.includes(`class="home-listing-cta" href="${target}"`)) {
    errors.push(`domov.html: chýba mobilný odkaz na plný zoznam ${target}`);
  }
}
const styles = await readFile(path.join(root, "public", "styles.css"), "utf8");
if (!styles.includes(".home-landing-page .columns .list > .ssr-list-item:nth-of-type(n + 4)")) {
  errors.push("styles.css: mobilný domov musí zobrazovať iba tri najnovšie položky v každom zozname");
}

if (errors.length) {
  console.error(`SEO kontrola zlyhala (${errors.length}):\n- ${errors.join("\n- ")}`);
  process.exit(1);
}

console.log(`SEO kontrola OK: ${pages.length} šablón, unikátne title/description/H1, alt texty a crawl routes.`);
