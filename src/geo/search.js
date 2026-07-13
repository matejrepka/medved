// Vyhľadávanie ľubovoľných slovenských lokalít pre administráciu. Lokálny
// gazetteer obsahuje iba obce, preto body záujmu (jazerá, doliny, vrchy…)
// dohľadávame cez OpenStreetMap Nominatim.

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_LIMIT = 100;

const cache = new Map();
let nominatimQueue = Promise.resolve();
let lastRequestAt = 0;

function normalizeQuery(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Malá tolerancia okolo hraníc SR. Country filter zostáva hlavnou kontrolou,
// toto navyše odfiltruje chybné alebo podvrhnuté súradnice.
export function isSlovakCoordinate(lat, lng) {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= 47.65 &&
    lat <= 49.7 &&
    lng >= 16.75 &&
    lng <= 22.65
  );
}

function remember(key, results) {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, results });
}

async function fetchFromNominatim(query) {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("countrycodes", "sk");
  url.searchParams.set("limit", "6");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("accept-language", "sk");
  url.searchParams.set("q", query);

  // Verejný Nominatim dovoľuje najviac približne jeden dopyt za sekundu.
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < 1000) await wait(1000 - elapsed);
  lastRequestAt = Date.now();

  const site = process.env.SITE_URL || "https://kdejemedved.sk";
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Language": "sk",
      "User-Agent": `KdeJeMedved/1.0 (${site})`,
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    throw new Error(`Nominatim odpovedal stavom ${response.status}.`);
  }

  const rows = await response.json();
  if (!Array.isArray(rows)) return [];

  const seen = new Set();
  const results = [];
  for (const row of rows) {
    const lat = Number(row.lat);
    const lng = Number(row.lon);
    const countryCode = row.address?.country_code;
    if (countryCode && countryCode !== "sk") continue;
    if (!isSlovakCoordinate(lat, lng)) continue;

    const name = normalizeQuery(row.name || String(row.display_name || "").split(",")[0]);
    const label = normalizeQuery(row.display_name || name);
    if (!name || !label) continue;

    const key = `${name.toLocaleLowerCase("sk")}|${lat.toFixed(5)}|${lng.toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      name,
      label,
      lat,
      lng,
      type: normalizeQuery(row.type || row.category || "lokalita"),
      source: "openstreetmap",
    });
  }

  return results;
}

/**
 * Vyhľadá obec, lokalitu alebo bod záujmu na Slovensku. Dopyty sú explicitné
 * (po kliknutí na Vyhľadať), cachované a serializované kvôli limitu Nominatimu.
 */
export async function searchSlovakLocations(value) {
  const query = normalizeQuery(value);
  if (query.length < 2 || query.length > 120) return [];

  const key = query.toLocaleLowerCase("sk");
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.results;
  if (cached) cache.delete(key);

  const run = nominatimQueue.then(() => fetchFromNominatim(query));
  // Po chybe musí front pokračovať, inak by sa zablokovali všetky ďalšie dopyty.
  nominatimQueue = run.catch(() => {});
  const results = await run;
  remember(key, results);
  return results;
}
