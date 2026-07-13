// Scraper pre tumedved.sk — používateľské hlásenia o výskyte medveďov.
//
// tumedved.sk je WordPress stránka a hlásenia sú vlastný typ príspevku
// "vyskyt-medveda" dostupný cez oficiálne WordPress REST API. Namiesto
// krehkého parsovania HTML čítame priamo štruktúrované JSON dáta.
//
// Každé hlásenie má pole `acf` (Advanced Custom Fields):
//   { lat, lng, datum: "YYYYMMDD", cas: "HH:MM", lokalita, poznamka }

import { dedupeSightings } from "../sightings-dedupe.js";

const BASE = "https://tumedved.sk/wp-json/wp/v2/vyskyt-medveda";
const USER_AGENT =
  "Mozilla/5.0 (medved-sledovac; osobny agregator hlaseni o medvedoch)";

// Bezpečnostný strop, aby sme nikdy nezahltili zdroj ani vlastnú pamäť.
const MAX_PAGES = 5;
const PER_PAGE = 100;

const TIMEZONE = "Europe/Bratislava";

/** "20260625" + "20:00" -> ISO reťazec v UTC (alebo null). */
function parseDatumCas(datum, cas) {
  if (!datum || datum.length !== 8) return null;
  const y = Number(datum.slice(0, 4));
  const m = Number(datum.slice(4, 6));
  const d = Number(datum.slice(6, 8));
  const time = /^\d{1,2}:\d{2}$/.test(cas || "") ? cas.padStart(5, "0") : "00:00";
  const [hh, mm] = time.split(":").map(Number);

  // Časy z tumedved.sk sú v slovenskom časovom pásme — prevedieme na UTC.
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
  if (Number.isNaN(guess.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(guess);
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  const wall = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
  const offsetMs = wall - guess.getTime();

  return new Date(guess.getTime() - offsetMs).toISOString();
}

/** Odstráni HTML značky a normalizuje medzery. */
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

function toFloat(v) {
  const n = parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Premení jeden surový WP príspevok na čistý objekt hlásenia. */
function normalize(post) {
  const acf = post.acf || {};
  const lat = toFloat(acf.lat);
  const lng = toFloat(acf.lng);
  // Dátum hlásenia podľa používateľa (acf.datum) má prednosť pred dátumom
  // publikovania príspevku.
  const reportedAt =
    parseDatumCas(acf.datum, acf.cas) ||
    (post.date_gmt ? new Date(post.date_gmt + "Z").toISOString() : null);

  const location = stripHtml(acf.lokalita) || stripHtml(post.title?.rendered) || "Neznáma lokalita";
  const note = stripHtml(acf.poznamka) || stripHtml(post.content?.rendered);
  const url = post.link || `https://tumedved.sk/?p=${post.id}`;

  return {
    id: `tm-${post.id}`,
    source: "tumedved.sk",
    sourceKey: "tumedved",
    location,
    note,
    lat,
    lng,
    hasCoords: lat !== null && lng !== null,
    reportedAt,
    datePrecision: acf.cas ? "datetime" : "date",
    url,
    sourceLinks: [
      {
        key: "tumedved",
        label: "tumedved.sk",
        url,
        sourceId: String(post.id),
      },
    ],
  };
}

/** Zostaví URL WP REST API pre danú stránku. */
function buildUrl(page) {
  return `${BASE}?per_page=${PER_PAGE}&page=${page}&orderby=date&order=desc&_fields=id,date_gmt,link,title,content,acf`;
}

/**
 * Rýchla cesta: priamy fetch. Keď web odpovedá Cloudflare výzvou (403), vráti
 * null a volajúci prejde na headless prehliadač. Iné HTTP chyby vyhodí ďalej.
 */
async function fetchDirect() {
  const all = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(buildUrl(page), {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 400) break; // WP vráti 400 keď požiadame o stránku za poslednou
    if (res.status === 403) return null; // pravdepodobne Cloudflare výzva → fallback
    if (!res.ok) {
      throw new Error(`tumedved.sk vrátil HTTP ${res.status}`);
    }

    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;

    all.push(...batch.map(normalize));

    const totalPages = Number(res.headers.get("x-wp-totalpages")) || 1;
    if (page >= totalPages) break;
  }

  return all;
}

/** Záložná cesta cez headless Chromium (prejde Cloudflare výzvou). */
async function fetchViaBrowser() {
  // Lenivý import — Playwright/Chromium načítame len keď ich naozaj treba.
  const { fetchJsonPagesViaBrowser } = await import("./browser-fetch.js");
  const raw = await fetchJsonPagesViaBrowser({
    homeUrl: "https://tumedved.sk/",
    pageUrl: buildUrl,
    maxPages: MAX_PAGES,
    perPage: PER_PAGE,
  });
  return raw.map(normalize);
}

/**
 * Stiahne hlásenia o výskyte medveďov z tumedved.sk.
 * Skúsi priamy fetch; pri Cloudflare výzve (alebo zlyhaní siete) prejde na
 * headless prehliadač.
 * @returns {Promise<Array>} zoznam normalizovaných hlásení (najnovšie prvé)
 */
export async function fetchTumedved() {
  let items = null;
  try {
    items = await fetchDirect();
  } catch (err) {
    console.warn(`[tumedved] priamy fetch zlyhal (${err.message}), skúšam prehliadač`);
  }

  if (items === null) {
    items = await fetchViaBrowser();
  }

  items = dedupeSightings(items);

  // Zoradíme od najnovšieho po najstaršie podľa nahláseného času.
  items.sort((a, b) => new Date(b.reportedAt || 0) - new Date(a.reportedAt || 0));
  return items;
}
