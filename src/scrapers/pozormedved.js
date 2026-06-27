// Scraper pre pozormedved.sk — oficiálne upozornenia ŠOP SR o výskyte medveďov.
//
// pozormedved.sk je WordPress stránka prevádzkovaná Štátnou ochranou prírody
// SR. Príspevky sú bežné WP posty dostupné cez štandardné REST API.
// Z titulku a tela článku extrahujeme lokality a geokódujeme ich na súradnice.

import { findPlace, loadPlaces } from "../geo/geocode.js";

const BASE = "https://pozormedved.sk/wp-json/wp/v2/posts";
const USER_AGENT =
  "Mozilla/5.0 (medved-sledovac; osobny agregator hlaseni o medvedoch)";

const MAX_PAGES = 5;
const PER_PAGE = 100;

function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(post, gz) {
  const title = stripHtml(post.title?.rendered) || "Bez názvu";
  const body = stripHtml(post.content?.rendered);
  const reportedAt = post.date_gmt
    ? new Date(post.date_gmt + "Z").toISOString()
    : null;

  const place = findPlace(title, body, gz);

  return {
    id: `pm-${post.id}`,
    source: "pozormedved.sk",
    location: place?.name || title,
    note: body.slice(0, 500),
    lat: place?.lat ?? null,
    lng: place?.lng ?? null,
    hasCoords: place != null,
    reportedAt,
    url: post.link || `https://pozormedved.sk/?p=${post.id}`,
  };
}

function buildUrl(page) {
  return `${BASE}?per_page=${PER_PAGE}&page=${page}&orderby=date&order=desc&_fields=id,date_gmt,link,title,content`;
}

async function fetchDirect(gz) {
  const all = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(buildUrl(page), {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 400) break;
    if (res.status === 403) return null;
    if (!res.ok) {
      throw new Error(`pozormedved.sk vrátil HTTP ${res.status}`);
    }

    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;

    all.push(...batch.map((post) => normalize(post, gz)));

    const totalPages = Number(res.headers.get("x-wp-totalpages")) || 1;
    if (page >= totalPages) break;
  }

  return all;
}

async function fetchViaBrowser(gz) {
  const { fetchJsonPagesViaBrowser } = await import("./browser-fetch.js");
  const raw = await fetchJsonPagesViaBrowser({
    homeUrl: "https://pozormedved.sk/",
    pageUrl: buildUrl,
    maxPages: MAX_PAGES,
    perPage: PER_PAGE,
  });
  return raw.map((post) => normalize(post, gz));
}

export async function fetchPozormedved() {
  const gz = await loadPlaces();

  let items = null;
  try {
    items = await fetchDirect(gz);
  } catch (err) {
    console.warn(`[pozormedved] priamy fetch zlyhal (${err.message}), skúšam prehliadač`);
  }

  if (items === null) {
    items = await fetchViaBrowser(gz);
  }

  items.sort((a, b) => new Date(b.reportedAt || 0) - new Date(a.reportedAt || 0));
  return items;
}
