// Scraper pre tumedved.sk — používateľské hlásenia o výskyte medveďov.
//
// tumedved.sk je WordPress stránka a hlásenia sú vlastný typ príspevku
// "vyskyt-medveda" dostupný cez oficiálne WordPress REST API. Namiesto
// krehkého parsovania HTML čítame priamo štruktúrované JSON dáta.
//
// Každé hlásenie má pole `acf` (Advanced Custom Fields):
//   { lat, lng, datum: "YYYYMMDD", cas: "HH:MM", lokalita, poznamka }

const BASE = "https://tumedved.sk/wp-json/wp/v2/vyskyt-medveda";
const USER_AGENT =
  "Mozilla/5.0 (medved-sledovac; osobny agregator hlaseni o medvedoch)";

// Bezpečnostný strop, aby sme nikdy nezahltili zdroj ani vlastnú pamäť.
const MAX_PAGES = 5;
const PER_PAGE = 100;

/** "20260625" + "20:00" -> ISO reťazec (alebo null). */
function parseDatumCas(datum, cas) {
  if (!datum || datum.length !== 8) return null;
  const y = datum.slice(0, 4);
  const m = datum.slice(4, 6);
  const d = datum.slice(6, 8);
  const time = /^\d{1,2}:\d{2}$/.test(cas || "") ? cas.padStart(5, "0") : "00:00";
  const iso = `${y}-${m}-${d}T${time}:00`;
  const dt = new Date(iso);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
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

  return {
    id: `tm-${post.id}`,
    source: "tumedved.sk",
    location,
    note,
    lat,
    lng,
    hasCoords: lat !== null && lng !== null,
    reportedAt,
    url: post.link || `https://tumedved.sk/?p=${post.id}`,
  };
}

/**
 * Stiahne hlásenia o výskyte medveďov z tumedved.sk.
 * @returns {Promise<Array>} zoznam normalizovaných hlásení (najnovšie prvé)
 */
export async function fetchTumedved() {
  const all = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${BASE}?per_page=${PER_PAGE}&page=${page}&orderby=date&order=desc&_fields=id,date_gmt,link,title,content,acf`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 400) break; // WP vráti 400 keď požiadame o stránku za poslednou
    if (!res.ok) {
      throw new Error(`tumedved.sk vrátil HTTP ${res.status}`);
    }

    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;

    all.push(...batch.map(normalize));

    const totalPages = Number(res.headers.get("x-wp-totalpages")) || 1;
    if (page >= totalPages) break;
  }

  // Zoradíme od najnovšieho po najstaršie podľa nahláseného času.
  all.sort((a, b) => new Date(b.reportedAt || 0) - new Date(a.reportedAt || 0));
  return all;
}
