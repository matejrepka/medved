import crypto from "node:crypto";
import { parseHTML } from "linkedom";

const MAP_URL = "https://www.sprejnamedveda.sk/medvede-na-mape/";
const DATA_URL = "https://www.sprejnamedveda.sk/mapa-2/";
const USER_AGENT = "Mozilla/5.0 (compatible; KdeJeMedved/1.0; +https://kdejemedved.sk)";

function dateOnlyToIso(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})$/);
  return match ? `${match[1]}T12:00:00.000Z` : null;
}

function cleanDescription(value) {
  const parts = String(value || "")
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  const specific = parts.filter((part) =>
    !/^V lokalite .+ bol zaznamenaný výskyt medveďa zo dňa \d{4}-\d{2}-\d{2}\.?$/iu.test(part)
  );
  return (specific.length ? specific : parts).join("\n\n");
}

function stableId(item) {
  const key = [item.location, item.observed_at, item.lat, item.lng, item.description]
    .map((value) => String(value || "").trim())
    .join("|");
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 20);
}

function normalize(row) {
  const id = stableId(row);
  const lat = Number(row.lat);
  const lng = Number(row.lng);
  return {
    id: `sprejnamedveda-${id}`,
    source: "sprejnamedveda.sk",
    sourceKey: "sprejnamedveda",
    location: row.location || row.title || "Lokalita neuvedená",
    note: cleanDescription(row.description),
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    hasCoords: Number.isFinite(lat) && Number.isFinite(lng),
    reportedAt: dateOnlyToIso(row.observed_at),
    datePrecision: "date",
    url: MAP_URL,
    sourceLinks: [
      {
        key: "sprejnamedveda",
        label: "sprejnamedveda.sk",
        url: MAP_URL,
        sourceId: id,
      },
    ],
  };
}

export async function fetchSprejnamedveda() {
  const response = await fetch(DATA_URL, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`sprejnamedveda.sk vrátil HTTP ${response.status}`);

  const { document } = parseHTML(await response.text());
  const encoded = document.querySelector("[data-sightings]")?.getAttribute("data-sightings");
  if (!encoded) throw new Error("sprejnamedveda.sk: stránka neobsahuje dáta mapy");

  let sightings;
  try {
    sightings = JSON.parse(encoded);
  } catch {
    throw new Error("sprejnamedveda.sk: dáta mapy majú neplatný formát");
  }
  if (!Array.isArray(sightings)) {
    throw new Error("sprejnamedveda.sk: zoznam hlásení má neplatný formát");
  }
  return sightings.map(normalize).filter((item) => item.reportedAt);
}

