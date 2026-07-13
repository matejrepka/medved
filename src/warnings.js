import { dedupeSightings, sightingSourceLinks } from "./sightings-dedupe.js";

const EXTERNAL_SIGHTING_KEYS = new Set(["tumedved", "mapamedvedov", "sprejnamedveda"]);

export function newsAsSighting(item) {
  if (item?.category !== "warning" || !item.hasCoords || !item.place || !item.date) return null;
  const url = item.articleUrl || item.googleNewsUrl || item.link;
  if (!url) return null;
  let host = "sprava";
  try {
    host = new URL(url).hostname.replace(/^www\./, "") || host;
  } catch {
    return null;
  }
  const key = `news:${host}`;
  return {
    id: `news-warning-${item.id}`,
    source: item.source || host,
    sourceKey: key,
    location: item.place,
    note: [item.title, item.snippet].filter(Boolean).join(". "),
    lat: item.lat,
    lng: item.lng,
    hasCoords: true,
    reportedAt: item.date,
    datePrecision: "datetime",
    url,
    sourceLinks: [
      {
        key,
        label: item.source || host,
        url,
        sourceId: String(item.id),
      },
    ],
  };
}

/**
 * Správy pripája iba k udalostiam z mapových zdrojov. Samostatné spravodajské
 * varovania ostávajú v /api/news a na mape sa naďalej vykreslia svojím markerom.
 */
export function mergeWarnings({ sightings = [], reports = [], news = [] }) {
  const newsWarnings = news.map(newsAsSighting).filter(Boolean);
  return dedupeSightings([...sightings, ...reports, ...newsWarnings]).filter((item) =>
    item.sourceType === "report" ||
    sightingSourceLinks(item).some((link) => EXTERNAL_SIGHTING_KEYS.has(link.key))
  );
}

