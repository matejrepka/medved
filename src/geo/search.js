// Nominatim dopĺňa Overpass: turistické trasy bývajú v OSM reláciách a ich
// názov môže byť v description/alt_name, ktoré bežný geokóder nevyhľadá.
import { isSlovakCoordinate, SLOVAK_COORDINATE_BOUNDS } from "./coordinates.js";
import { loadPlaces, lookupPlaceByName } from "./geocode.js";
import { normalizePlaceQuery, searchTouristPlaces } from "./tourist-places.js";

export { isSlovakCoordinate } from "./coordinates.js";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OVERPASS_URLS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
// OSM administratívna hranica Slovenska: relation/14296, area = 3600000000 + id.
const SLOVAK_OSM_AREA = 3600014296;
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_LIMIT = 100;
const { minLat, minLng, maxLat, maxLng } = SLOVAK_COORDINATE_BOUNDS;
const SLOVAK_BBOX = `${minLat},${minLng},${maxLat},${maxLng}`;
const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requestHeaders() {
  return {
    Accept: "application/json",
    "Accept-Language": "sk",
    "User-Agent": `KdeJeMedved/1.0 (${process.env.SITE_URL || "https://www.kdejemedved.sk"})`,
  };
}

function nominatimResults(rows) {
  return (Array.isArray(rows) ? rows : []).flatMap((row) => {
    const lat = Number(row.lat);
    const lng = Number(row.lon);
    if (row.address?.country_code && row.address.country_code !== "sk") return [];
    if (!isSlovakCoordinate(lat, lng)) return [];
    const name = clean(row.name || String(row.display_name || "").split(",")[0]);
    const label = clean(row.display_name || name);
    return name && label ? [{ name, label, lat, lng,
      type: clean(row.type || row.category || "lokalita"), source: "openstreetmap" }] : [];
  });
}

// Regex toleruje diakritiku aj pri dopyte bez nej. Vstup sa najprv obmedzí
// na písmená/čísla/medzery a pri vložení do Overpass QL sa escapuje ako JSON.
function namePattern(query) {
  const accents = { a: "[aáä]", c: "[cč]", d: "[dď]", e: "[eé]", i: "[ií]",
    l: "[lĺľ]", n: "[nň]", o: "[oóô]", r: "[rŕ]", s: "[sš]", t: "[tť]",
    u: "[uú]", y: "[yý]", z: "[zž]" };
  return normalizePlaceQuery(query).split(" ")
    .map((word) => [...word].map((char) => accents[char] || char).join(""))
    .join("[^[:alnum:]]+");
}

function representativePoint(element, bbox = "") {
  const bounds = bbox ? bbox.split(",").map(Number) : null;
  const inRegion = (point) => isSlovakCoordinate(point?.lat, point?.lon) &&
    (!bounds || (point.lat >= bounds[0] && point.lon >= bounds[1] && point.lat <= bounds[2] && point.lon <= bounds[3]));
  if (element.type === "node") return inRegion(element) ? { lat: element.lat, lng: element.lon } : null;
  const points = (element.geometry || element.members?.flatMap((member) => member.geometry || []) || [])
    .filter(inRegion);
  if (!points.length) return null;
  // Bod geometrie najbližšie k jej stredu. Samotný stred bounding boxu môže
  // ležať mimo chodníka, na opačnom svahu či v obci.
  const center = points.reduce((sum, point) => ({ lat: sum.lat + point.lat, lng: sum.lng + point.lon }), { lat: 0, lng: 0 });
  center.lat /= points.length;
  center.lng /= points.length;
  const distance = (point) => (point.lat - center.lat) ** 2 + ((point.lon - center.lng) * Math.cos(center.lat * Math.PI / 180)) ** 2;
  const nearest = points.reduce((best, point) => distance(point) < distance(best) ? point : best);
  return { lat: nearest.lat, lng: nearest.lon };
}

function overpassResults(elements, query, bbox) {
  const key = normalizePlaceQuery(query);
  return (Array.isArray(elements) ? elements : []).flatMap((element) => {
    const tags = element.tags || {};
    const route = ["hiking", "foot", "bicycle"].includes(tags.route);
    const names = [tags["name:sk"], tags.name, tags.official_name, tags.alt_name, tags.loc_name,
      ...(route ? [tags.description] : [])].filter(Boolean).flatMap((name) => name.split(";"));
    const matches = names.filter((name) => (" " + normalizePlaceQuery(name) + " ").includes(" " + key + " "));
    if (!matches.length) return [];
    const point = representativePoint(element, bbox);
    if (!point || !isSlovakCoordinate(point.lat, point.lng)) return [];
    const name = clean(matches.find((name) => normalizePlaceQuery(name) === key) || tags["name:sk"] || tags.name || tags.description || matches[0]);
    const type = tags.route || tags.natural || tags.information || tags.tourism || tags.place || tags.highway || "lokalita";
    const label = [name, tags.ref, tags["addr:city"], "Slovensko"].filter(Boolean).join(", ") +
      (route ? " — orientačný bod na trase" : "");
    return [{ name, label, ...point, type, source: "openstreetmap", ...(route ? { precision: "route" } : {}) }];
  }).sort((a, b) => Number(normalizePlaceQuery(b.name) === key) - Number(normalizePlaceQuery(a.name) === key));
}

function uniqueResults(results) {
  const seen = new Set();
  return results.filter((result) => {
    const key = normalizePlaceQuery(result.name) + "|" + result.lat.toFixed(4) + "|" + result.lng.toFixed(4);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
}

/** Vlastná fronta a cache umožňujú izolované testy bez skutočných HTTP dopytov. */
export function createLocationSearch({ fetchImpl = (...args) => fetch(...args), now = Date.now, sleep = wait, minIntervalMs = 1000 } = {}) {
  const cache = new Map();
  const pending = new Map();
  let queue = Promise.resolve();
  let lastRequestAt = -Infinity;

  async function nominatim(query) {
    const remaining = minIntervalMs - (now() - lastRequestAt);
    if (remaining > 0) await sleep(remaining);
    lastRequestAt = now();
    const url = new URL(NOMINATIM_URL);
    for (const [name, value] of Object.entries({ format: "jsonv2", countrycodes: "sk", limit: "6",
      addressdetails: "1", "accept-language": "sk", q: query })) url.searchParams.set(name, value);
    const response = await fetchImpl(url, { headers: requestHeaders(), signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error("Nominatim odpovedal stavom " + response.status + ".");
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error("Nominatim vrátil neplatnú odpoveď.");
    return rows;
  }

  async function overpass(query, bbox = "", exact = true) {
    const pattern = JSON.stringify(exact ? query : namePattern(query));
    const comparison = (exact ? "=" : "~") + pattern + (exact ? "" : ",i");
    const scope = "(area.sk)(" + (bbox || SLOVAK_BBOX) + ")";
    // Pevné kľúče využijú OSM index; regex cez všetky kľúče na území celej
    // krajiny je podstatne pomalší a môže prekročiť limit verejnej služby.
    const names = ["name", "name:sk", "alt_name", "loc_name", "official_name"]
      .map((key) => 'nwr' + scope + '[' + JSON.stringify(key) + comparison + '];').join("");
    const data = '[out:json][timeout:12];area(' + SLOVAK_OSM_AREA + ')->.sk;(' +
      names + 'relation' + scope + '[route~"^(hiking|foot|bicycle)$"][description' + comparison + '];);out geom 30;';
    let payload;
    for (const endpoint of OVERPASS_URLS) {
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST", headers: requestHeaders(), body: new URLSearchParams({ data }), signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) {
          const error = new Error("Overpass odpovedal stavom " + response.status + ".");
          error.status = response.status;
          throw error;
        }
        payload = await response.json();
        if (payload.remark || !Array.isArray(payload.elements)) throw new Error("Overpass nedokončil vyhľadávanie.");
        break;
      } catch (err) {
        const retryable = !err.status || [429, 500, 502, 503, 504].includes(err.status);
        if (endpoint === OVERPASS_URLS.at(-1) || !retryable) throw err;
      }
    }
    const results = overpassResults(payload.elements, query, bbox);
    // Najprv lacná presná zhoda v indexe, potom širšie hľadanie názvov bez
    // diakritiky, alternatívnych názvov a častí opisu trasy.
    return exact && !results.length ? overpass(query, bbox, false) : results;
  }

  async function search(query) {
    let rows = [];
    let primaryError;
    try { rows = await nominatim(query); } catch (err) { primaryError = err; }
    const results = nominatimResults(rows);
    if (results.some((row) => normalizePlaceQuery(row.name) === normalizePlaceQuery(query))) return uniqueResults(results);

    // Pri doplnenom regióne ho použijeme ako hranice vyhľadávania. Nikdy
    // neskrátime kvalifikovaný názov na prvú časť bez geografického kontextu.
    const parts = query.split(/\s*,\s*|\s+(?:v|vo)\s+/i);
    let name = query;
    let bbox = "";
    if (parts.length === 2 && parts.every(Boolean)) {
      let regions;
      try { regions = await nominatim(parts[1]); }
      catch (err) {
        if (results.length) return uniqueResults(results);
        throw err;
      }
      const region = regions.find((row) => row.boundingbox?.length === 4 &&
        nominatimResults([row]).length &&
        ["boundary", "place", "natural", "leisure"].includes(row.category || row.class));
      if (!region) {
        if (primaryError && !results.length) throw primaryError;
        return uniqueResults(results);
      }
      const [south, north, west, east] = region.boundingbox.map(Number);
      if ([south, north, west, east].every(Number.isFinite) && south < north && west < east) {
        bbox = south + "," + west + "," + north + "," + east;
        name = parts[0];
      }
    }
    if (normalizePlaceQuery(name).length < 4) {
      if (primaryError && !results.length) throw primaryError;
      return uniqueResults(results);
    }
    try {
      const fallback = await overpass(name, bbox);
      if (primaryError && !fallback.length && !results.length) throw primaryError;
      return uniqueResults([...fallback, ...results]);
    }
    catch (err) {
      if (results.length) return uniqueResults(results);
      throw err;
    }
  }

  return async function searchSlovakLocations(value) {
    const query = clean(value);
    if (query.length < 2 || query.length > 120) return [];
    const local = searchTouristPlaces(query);
    if (local.length) return local;
    const key = normalizePlaceQuery(query);
    if (!key) return [];
    const cached = cache.get(key);
    if (cached?.expiresAt > now()) return cached.results;
    if (cached) cache.delete(key);
    if (pending.has(key)) return pending.get(key);
    const run = queue.then(() => search(query));
    queue = run.catch(() => {});
    const remembered = run.then((results) => {
      if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
      cache.set(key, { expiresAt: now() + CACHE_TTL_MS, results });
      return results;
    }).finally(() => pending.delete(key));
    pending.set(key, remembered);
    return remembered;
  };
}

export const searchSlovakLocations = createLocationSearch();

/** Automatická lokalizácia nesmie zameniť napr. „Suchá Belá“ za obec „Suchá“. */
export async function resolveSlovakLocation(name, { searchLocations = searchSlovakLocations } = {}) {
  const local = searchTouristPlaces(name)[0];
  if (local) return local;
  const municipality = lookupPlaceByName(name, await loadPlaces(), { exactOnly: true });
  if (municipality) return municipality;
  const queryName = normalizePlaceQuery(clean(name).split(/\s*,\s*|\s+(?:v|vo)\s+/i)[0]);
  const results = await searchLocations(name);
  return results.find((result) =>
    (" " + normalizePlaceQuery(result.name) + " ").includes(" " + queryName + " ")
  ) || null;
}
