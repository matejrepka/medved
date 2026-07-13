const PAGE_URL = "https://mapamedvedov.sk/";
const USER_AGENT = "Mozilla/5.0 (compatible; KdeJeMedved/1.0; +https://kdejemedved.sk)";

function dateOnlyToIso(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})$/);
  return match ? `${match[1]}T12:00:00.000Z` : null;
}

function extractJsonArray(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "[") depth += 1;
    else if (char === "]" && --depth === 0) return text.slice(start, index + 1);
  }
  return null;
}

function observationsFromNextFlight(html) {
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)/g)]
    .map((match) => {
      try {
        return JSON.parse(match[1]);
      } catch {
        return "";
      }
    });
  const marker = '"initial":';
  const payload = chunks.find((chunk) => chunk.includes(`${marker}[`));
  if (!payload) throw new Error("mapamedvedov.sk: stránka neobsahuje očakávané dáta mapy");

  const start = payload.indexOf(marker) + marker.length;
  const json = extractJsonArray(payload, start);
  if (!json) throw new Error("mapamedvedov.sk: nepodarilo sa oddeliť zoznam pozorovaní");

  const observations = JSON.parse(json);
  if (!Array.isArray(observations)) {
    throw new Error("mapamedvedov.sk: zoznam pozorovaní má neplatný formát");
  }
  return observations;
}

function normalize(row) {
  const id = String(row.id);
  const url = `https://mapamedvedov.sk/pozorovanie/${encodeURIComponent(id)}`;
  const lat = Number(row.lat);
  const lng = Number(row.lng);
  const reportedAt = dateOnlyToIso(row.occurred_at);

  return {
    id: `mapamedvedov-${id}`,
    source: "mapamedvedov.sk",
    sourceKey: "mapamedvedov",
    location: row.location_text || "Lokalita neuvedená",
    note: row.description || row.article_text || "",
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    hasCoords: Number.isFinite(lat) && Number.isFinite(lng),
    reportedAt,
    datePrecision: "date",
    url,
    sourceLinks: [
      {
        key: "mapamedvedov",
        label: "mapamedvedov.sk",
        url,
        sourceId: id,
      },
    ],
    originalUrl: row.source_facebook_url || row.article_url || null,
  };
}

/** Načíta iba schválené hlásenia používateľov, nie spravodajské prepisy webu. */
export async function fetchMapamedvedov() {
  const response = await fetch(PAGE_URL, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`mapamedvedov.sk vrátil HTTP ${response.status}`);

  return observationsFromNextFlight(await response.text())
    .filter((row) => row?.status === "approved" && row?.source === "user")
    .map(normalize)
    .filter((item) => item.reportedAt);
}

