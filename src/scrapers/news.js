// Scraper slovenských správ o medveďoch.
//
// Namiesto scrapovania desiatok spravodajských webov (každý s iným HTML
// a anti-bot ochranou) využívame agregátor Google News a jeho RSS výstup.
// Pre slovenské výsledky používame hl=sk, gl=SK, ceid=SK:sk.
//
// Spustíme viacero hľadaní (výskyt, útok, stretnutie...), výsledky zlúčime
// a odstránime duplicity podľa normalizovaného názvu.

import Parser from "rss-parser";
import { geocodeNews } from "../geo/geocode.js";
import { fetchArticleBodies } from "./article.js";

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

/**
 * Stiahne a zlúči slovenské správy o medveďoch.
 * @returns {Promise<Array>} zoznam článkov (najnovšie prvé)
 */
export async function fetchNews() {
  const settled = await Promise.allSettled(
    QUERIES.map((q) => parser.parseURL(FEED_URL(q)))
  );

  const byKey = new Map();

  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const item of result.value.items || []) {
      const { title, source: titleSource } = splitTitleSource(item.title);
      if (!title) continue;

      const snippet = stripHtml(item.contentSnippet || item.content);
      // Odfiltruje články, ktoré medveďa len spomenú/odkazujú naň, ale nie sú o ňom.
      if (!isBearRelated(title, snippet)) continue;

      const key = dedupeKey(title);
      const date = item.isoDate || item.pubDate || null;

      const existing = byKey.get(key);
      // Ak duplicita existuje, ponecháme novší záznam.
      if (existing && new Date(existing.date || 0) >= new Date(date || 0)) {
        continue;
      }

      byKey.set(key, {
        id: `news-${key}`,
        source: titleSource || item.sourceTag || hostFromLink(item.link),
        title,
        link: item.link || "",
        snippet,
        date: date ? new Date(date).toISOString() : null,
      });
    }
  }

  const items = [...byKey.values()]
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
    .slice(0, MAX_ITEMS);

  // Stiahni telo každého článku (rozbalí Google News odkaz + Readability),
  // aby sme obec hľadali z celého textu článku, nie len z krátkeho popisu.
  // Ak sa článok nepodarí stiahnuť, geokódovanie spadne späť na titulok/snippet.
  const bodies = await fetchArticleBodies(items, { concurrency: 6, timeoutMs: 12000 });
  for (const it of items) {
    const r = bodies.get(it.link);
    if (r) {
      it.body = r.body || "";
      if (r.url) it.articleUrl = r.url; // priama URL článku (mimo Google News)
    }
  }

  // Z titulku + tela článku doplní obec a súradnice (pre značku na mape).
  const geocoded = await geocodeNews(items);
  // `body` ďalej nepotrebujeme posielať klientovi — zbytočne veľké.
  return geocoded.map(({ body, ...rest }) => rest);
}

function hostFromLink(link) {
  try {
    return new URL(link).hostname.replace(/^www\./, "");
  } catch {
    return "Google News";
  }
}
