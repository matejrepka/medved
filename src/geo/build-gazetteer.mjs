// Jednorazový build gazetteera: stiahne VŠETKY slovenské obce a mestá z
// OpenStreetMap cez Overpass API (jeden dopyt) a uloží ich so súradnicami do
// sk-places.json. Za behu appky sa už nič nesťahuje — len sa v texte článku
// hľadá zhoda s týmto súborom.
//
// Spustenie (treba internet):
//   node src/geo/build-gazetteer.mjs   (alebo: npm run build:geo)
//
// Overpass vráti ~2900 sídiel typu city/town/village = prakticky všetky obce SR.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "sk-places.json");
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const UA = "medved-sledovac/1.0 (osobny projekt; gazetteer builder)";

// Všetky body typu mesto/mestečko/obec v rámci Slovenska, ktoré majú názov.
const QUERY = `[out:json][timeout:180];
area["ISO3166-1"="SK"][admin_level=2]->.sk;
(node["place"~"^(city|town|village)$"]["name"](area.sk););
out;`;

// Poradie dôležitosti sídla (pri zhode názvu/dvojzmysle uprednostníme väčšie).
const RANK = { city: 3, town: 2, village: 1 };

async function fetchOverpass() {
  let lastErr;
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        body: "data=" + encodeURIComponent(QUERY),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": UA,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(180000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      console.warn(`Overpass ${url} zlyhal: ${e.message} — skúšam ďalší…`);
      lastErr = e;
    }
  }
  throw lastErr;
}

const json = await fetchOverpass();
const elements = json.elements || [];

// Dedup podľa normalizovaného názvu — pri rovnomenných obciach necháme väčšiu.
const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const byName = new Map();
let skipped = 0;

for (const el of elements) {
  const name = el.tags?.name;
  const lat = el.lat;
  const lng = el.lon;
  const type = el.tags?.place;
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    skipped++;
    continue;
  }
  const key = norm(name);
  const existing = byName.get(key);
  if (!existing || (RANK[type] || 0) > (RANK[existing.type] || 0)) {
    byName.set(key, { name, lat: +lat.toFixed(5), lng: +lng.toFixed(5), type });
  }
}

const out = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, "sk"));
await writeFile(OUT, JSON.stringify(out) + "\n", "utf8");

console.log(
  `Hotovo: ${out.length} obcí uložených do ${OUT} ` +
    `(stiahnutých ${elements.length}, preskočených ${skipped}).`
);
