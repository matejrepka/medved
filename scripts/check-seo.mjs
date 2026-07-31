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
  "spravy.html",
  "varovania.html",
  "zaznam.html",
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
  if (html.includes("site-footer")) {
    for (const archivePath of ["/spravy", "/varovania"]) {
      if (!html.includes(`href="${archivePath}"`)) {
        errors.push(`${file}: pätička neodkazuje na ${archivePath}`);
      }
    }
  }
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
if (!locationTemplate.includes("<!-- LOCATION_SUMMARY -->")) {
  errors.push("location.html: chýba LOCATION_SUMMARY token");
}

const manifest = JSON.parse(await readFile(path.join(root, "public", "manifest.webmanifest"), "utf8"));
if (manifest.lang !== "sk") errors.push("manifest.webmanifest: lang musí byť sk");

const server = await readFile(path.join(root, "server.js"), "utf8");
for (const route of ["/robots.txt", "/sitemap.xml", "/llms.txt", "/feed.xml"]) {
  if (!server.includes(`app.get(\"${route}\"`)) errors.push(`server.js: chýba route ${route}`);
}
if (!server.includes("LOCATION_ROUTE_PREFIX")) errors.push("server.js: chýbajú lokalitné SEO stránky");
if (!server.includes("notifyIndexNow")) errors.push("server.js: chýba IndexNow aktualizácia");
if (!server.includes('const NEWS_ROUTE_PREFIX = "/spravy/"')) {
  errors.push("server.js: chýbajú detailné SEO stránky správ");
}
if (!server.includes('const WARNING_ROUTE_PREFIX = "/varovania/"')) {
  errors.push("server.js: chýbajú detailné SEO stránky varovaní");
}
if (!server.includes("detailRows.set(newsPath(item)")) {
  errors.push("server.js: sitemap neobsahuje detailné stránky správ");
}
if (!server.includes("detailRows.set(warningPath(item)")) {
  errors.push("server.js: sitemap neobsahuje detailné stránky varovaní");
}
if (!server.includes('const CANONICAL_SITE_ORIGIN = "https://www.kdejemedved.sk"')) {
  errors.push("server.js: kanonický origin musí byť https://www.kdejemedved.sk");
}
if (!server.includes("mergeLocationPages(locationCandidates)")) {
  errors.push("server.js: lokalitné stránky musia byť deduplikované podľa slugu");
}
if (!server.includes('"<!-- RECORD_SUMMARY_HEADING -->"') || !server.includes('"<!-- RECORD_SUMMARY -->"')) {
  errors.push("server.js: detail článku musí vykresliť nadpis a obsah súhrnu");
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
for (const target of ["/varovania", "/spravy"]) {
  if (!home.includes(`class="home-listing-cta" href="${target}"`)) {
    errors.push(`domov.html: chýba mobilný odkaz na plný zoznam ${target}`);
  }
}
const styles = await readFile(path.join(root, "public", "styles.css"), "utf8");
if (!styles.includes(".home-landing-page .columns .list > .ssr-list-item:nth-of-type(n + 4)")) {
  errors.push("styles.css: mobilný domov musí zobrazovať iba tri najnovšie položky v každom zozname");
}

const pageShell = await readFile(path.join(root, "public", "page.js"), "utf8");
for (const archivePath of ["/spravy", "/varovania"]) {
  if (!pageShell.includes(`href: "${archivePath}"`)) {
    errors.push(`page.js: mobilné menu neodkazuje na ${archivePath}`);
  }
}

const recordTemplate = await readFile(path.join(root, "public", "zaznam.html"), "utf8");
if (!recordTemplate.includes("<!-- RECORD_SUMMARY_HEADING -->") || !recordTemplate.includes("<!-- RECORD_SUMMARY -->")) {
  errors.push("zaznam.html: každý detail musí obsahovať blok súhrnu");
}

const publicApp = await readFile(path.join(root, "public", "app.js"), "utf8");
if (!publicApp.includes("card-detail-action") || !publicApp.includes("Detail záznamu")) {
  errors.push("app.js: karta musí mať jasne zoskupenú akciu detailu");
}

for (const file of ["spravy.html", "varovania.html", "zaznam.html"]) {
  const html = await readFile(path.join(root, "public", file), "utf8");
  if (/[—–]/u.test(html)) errors.push(`${file}: obsahuje nepovolenú typografickú pomlčku`);
}

if (errors.length) {
  console.error(`SEO kontrola zlyhala (${errors.length}):\n- ${errors.join("\n- ")}`);
  process.exit(1);
}

console.log(`SEO kontrola OK: ${pages.length} šablón, unikátne title/description/H1, alt texty a crawl routes.`);
