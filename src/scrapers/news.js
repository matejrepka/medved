// Scraper slovenských správ o medveďoch.
//
// Dva zdroje:
//  1. Google News RSS — agregátor spravodajských webov (výskyt, útok, stretnutie…)
//  2. pozormedved.sk — oficiálne upozornenia ŠOP SR (WordPress REST API)
//
// Výsledky z oboch zdrojov zlúčime, geokódujeme a odstránime duplicity.

import Parser from "rss-parser";
import { geocodeNews } from "../geo/geocode.js";
import { fetchArticleBodies, googleNewsWebUrl } from "./article.js";

const parser = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "Mozilla/5.0 (medved-sledovac news reader)" },
  customFields: { item: [["source", "sourceTag"]] },
});

// Vyhľadávacie dopyty zamerané na výskyt a stretnutia s medveďmi na Slovensku.
const QUERIES = [
  "medveď výskyt Slovensko",
  "medveď útok Slovensko",
  "medveď stretnutie turista",
  "medvede obec Slovensko",
  "medveď pozorovanie",
];

const FEED_URL = (q) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(
    q + " when:30d"
  )}&hl=sk&gl=SK&ceid=SK:sk`;

const MAX_ITEMS = 60;

function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function stripTrailingSource(text) {
  return (text || "")
    .replace(/\s+[\p{L}\p{N}.-]+\.(?:sk|cz|com|eu|net|org)\s*$/iu, "")
    .trim();
}

/**
 * Google News dáva názvy ako "Titulok - Zdroj". Oddelíme názov od zdroja.
 * @returns {{title: string, source: string|null}}
 */
function splitTitleSource(rawTitle) {
  if (!rawTitle) return { title: "", source: null };
  const idx = rawTitle.lastIndexOf(" - ");
  if (idx > 0 && idx > rawTitle.length - 60) {
    return {
      title: rawTitle.slice(0, idx).trim(),
      source: rawTitle.slice(idx + 3).trim() || null,
    };
  }
  return { title: rawTitle.trim(), source: null };
}

/** Kľúč pre deduplikáciu — názov bez diakritiky, interpunkcie a medzier. */
function dedupeKey(title) {
  return title
    .toLowerCase()
    .normalize("NFD") // rozdelí písmená s diakritikou na základ + značku
    .replace(/[^a-z0-9]+/g, "") // odstráni značky diakritiky aj interpunkciu
    .slice(0, 80);
}

/** Text bez diakritiky a malými písmenami — na hľadanie kľúčových slov. */
function normalize(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

// Slovník medvedích výrazov (bez diakritiky). Kmeň "medved" pokryje medveď,
// medvede, medveďov, medvedica, medvedí, medvedie… Pridávame aj synonymá.
const BEAR_TERMS = ["medved", "grizly", "ursus"];

/**
 * Je článok naozaj o medveďovi? Google News dáva výsledky podľa celého textu
 * stránky, takže sa medzi ne dostanú aj články, ktoré medveďa len spomenú alebo
 * naň odkazujú (napr. správa o suchu s odkazom na iný článok). Preto vyžadujeme,
 * aby sa medvedí výraz vyskytol priamo v titulku alebo v popise (snippet) — to
 * sú časti, ktoré patria konkrétnemu článku, nie celej stránke.
 */
function isBearRelated(title, snippet) {
  const haystack = normalize(`${title} ${snippet}`);
  return BEAR_TERMS.some((term) => haystack.includes(term));
}

// --- pozormedved.sk (ŠOP SR) ---

const PM_BASE = "https://pozormedved.sk/wp-json/wp/v2/posts";
const PM_PER_PAGE = 50;
const PM_MAX_PAGES = 3;

async function fetchPozormedvedPosts() {
  const items = [];

  for (let page = 1; page <= PM_MAX_PAGES; page++) {
    const url = `${PM_BASE}?per_page=${PM_PER_PAGE}&page=${page}&orderby=date&order=desc&_fields=id,date_gmt,link,title,content,excerpt`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (medved-sledovac news reader)", Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 400) break;
    if (!res.ok) break;

    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const post of batch) {
      const title = stripHtml(post.title?.rendered);
      if (!title) continue;

      const body = stripHtml(post.content?.rendered || "");
      const snippet = stripHtml(post.excerpt?.rendered || "").slice(0, 500) || body.slice(0, 500);
      const dateGmt = post.date_gmt ? new Date(post.date_gmt + "Z").toISOString() : null;

      items.push({
        id: `news-pm${post.id}`,
        source: "pozormedved.sk",
        title,
        link: post.link || `https://pozormedved.sk/?p=${post.id}`,
        articleUrl: post.link || null,
        googleNewsUrl: null,
        snippet,
        body,
        date: dateGmt,
        rssDate: dateGmt,
      });
    }

    const totalPages = Number(res.headers.get("x-wp-totalpages")) || 1;
    if (page >= totalPages) break;
  }

  return items;
}

// --- Zlúčenie oboch zdrojov ---

/**
 * Stiahne a zlúči slovenské správy o medveďoch z Google News a pozormedved.sk.
 * @returns {Promise<Array>} zoznam článkov (najnovšie prvé)
 */
export async function fetchNews() {
  // 1. Google News RSS
  const settled = await Promise.allSettled(
    QUERIES.map((q) => parser.parseURL(FEED_URL(q)))
  );

  const byKey = new Map();

  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const item of result.value.items || []) {
      const { title, source: titleSource } = splitTitleSource(item.title);
      if (!title) continue;

      const snippet = stripTrailingSource(stripHtml(item.contentSnippet || item.content));
      if (!isBearRelated(title, snippet)) continue;

      const key = dedupeKey(title);
      const date = item.isoDate || item.pubDate || null;
      const rssDate = date ? new Date(date).toISOString() : null;

      const existing = byKey.get(key);
      if (existing && new Date(existing.rssDate || 0) >= new Date(rssDate || 0)) {
        continue;
      }

      const link = item.link || "";

      byKey.set(key, {
        id: `news-${key}`,
        source: titleSource || item.sourceTag || hostFromLink(link),
        title,
        link,
        googleNewsUrl: googleNewsWebUrl(link),
        snippet,
        date: null,
        rssDate,
      });
    }
  }

  const gnItems = [...byKey.values()]
    .sort((a, b) => new Date(b.rssDate || 0) - new Date(a.rssDate || 0))
    .slice(0, MAX_ITEMS);

  // 2. Stiahni telá článkov z Google News
  const bodies = await fetchArticleBodies(gnItems, { concurrency: 2, timeoutMs: 15000 });
  for (const it of gnItems) {
    const r = bodies.get(it.link);
    if (r) {
      it.body = r.body || "";
      if (r.url) it.articleUrl = r.url;
      if (r.googleNewsUrl) it.googleNewsUrl = r.googleNewsUrl;
      if (r.publishedAt) it.date = r.publishedAt;
    }
  }

  // 3. pozormedved.sk — príspevky už majú telo z WP API, sťahovať netreba
  let pmItems = [];
  try {
    pmItems = await fetchPozormedvedPosts();
  } catch (err) {
    console.warn(`[pozormedved] fetch failed: ${err.message}`);
  }

  // 4. Zlúčenie a geokódovanie
  const allItems = gnItems.concat(pmItems);
  const geocoded = await geocodeNews(allItems);
  geocoded.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  return geocoded.map(({ body, rssDate, ...rest }) => {
    // Celé telo potrebuje len AI klasifikácia nových správ. Neenumerovateľná
    // vlastnosť sa neodošle verejným API ani neuloží do JSON payloadu.
    Object.defineProperty(rest, "_analysisBody", {
      value: String(body || "").slice(0, 12000),
      enumerable: false,
    });
    return rest;
  });
}

function hostFromLink(link) {
  try {
    return new URL(link).hostname.replace(/^www\./, "");
  } catch {
    return "Google News";
  }
}
