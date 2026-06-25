// Stiahnutie a extrakcia TELA článku.
//
// Google News RSS dáva len zakódovaný odkaz (news.google.com/rss/articles/CBMi…),
// ktorý treba najprv rozbaliť na reálnu URL článku, potom stránku stiahnuť a
// vytiahnuť z nej IBA samotný článok (nadpis + text) — bez reklám, navigácie,
// súvisiacich odkazov a pätičky. Na to slúži Mozilla Readability.

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const MONTHS_SK = new Map([
  ["januar", 1],
  ["januara", 1],
  ["februar", 2],
  ["februara", 2],
  ["marec", 3],
  ["marca", 3],
  ["april", 4],
  ["aprila", 4],
  ["maj", 5],
  ["maja", 5],
  ["jun", 6],
  ["juna", 6],
  ["jul", 7],
  ["jula", 7],
  ["august", 8],
  ["augusta", 8],
  ["september", 9],
  ["septembra", 9],
  ["oktober", 10],
  ["oktobra", 10],
  ["november", 11],
  ["novembra", 11],
  ["december", 12],
  ["decembra", 12],
]);

function googleNewsArticleId(gnUrl) {
  if (!gnUrl) return null;
  try {
    const url = new URL(gnUrl);
    const match = url.pathname.match(/\/(?:rss\/)?articles\/([^/?#]+)/);
    return match?.[1] || null;
  } catch {
    return gnUrl.split("/articles/")[1]?.split(/[?#]/)[0] || null;
  }
}

export function googleNewsWebUrl(gnUrl) {
  const id = googleNewsArticleId(gnUrl);
  if (!id) return gnUrl || "";
  return `https://news.google.com/articles/${id}?hl=sk&gl=SK&ceid=SK:sk`;
}

function firstExternalUrl(text) {
  const unescaped = text
    .replace(/\\\//g, "/")
    .replace(/\\u0026/g, "&")
    .replace(/\\u003d/g, "=");
  const urls = unescaped.match(/https?:\/\/[^"'\]<>\s\\]+/g) || [];

  return (
    urls.find((u) => {
      try {
        const host = new URL(u).hostname.replace(/^www\./, "");
        return (
          host !== "google.com" &&
          !host.endsWith(".google.com") &&
          host !== "gstatic.com" &&
          !host.endsWith(".gstatic.com") &&
          host !== "googleusercontent.com" &&
          !host.endsWith(".googleusercontent.com")
        );
      } catch {
        return false;
      }
    }) || null
  );
}

/**
 * Rozbalí zakódovaný odkaz Google News na reálnu URL článku.
 * Postup: stiahne stránku článku (kvôli podpisu sg/ts), potom zavolá interné
 * Google "batchexecute" RPC, ktoré vráti cieľovú adresu. Ak čokoľvek zlyhá,
 * vráti null a volajúci použije nadpis/snippet.
 */
async function resolveGoogleNewsUrl(gnUrl, signal) {
  const id = googleNewsArticleId(gnUrl);
  if (!id) return null;

  const pageUrl = `https://news.google.com/rss/articles/${id}?hl=sk&gl=SK&ceid=SK:sk`;
  const page = await fetch(pageUrl, {
    headers: { "User-Agent": UA },
    signal,
  });
  if (!page.ok) return null;
  const html = await page.text();

  const sg = html.match(/data-n-a-sg="([^"]+)"/);
  const ts = html.match(/data-n-a-ts="([^"]+)"/);
  if (!sg || !ts) return null;

  const inner = `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${id}",${ts[1]},"${sg[1]}"]`;
  const body = "f.req=" + encodeURIComponent(JSON.stringify([[["Fbv4je", inner]]]));

  const rpc = await fetch(
    "https://news.google.com/_/DotsSplashUi/data/batchexecute",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "User-Agent": UA,
      },
      body,
      signal,
    }
  );
  if (!rpc.ok) return null;
  const txt = await rpc.text();
  // V odpovedi je cieľová URL (escapovaná). Vezmeme prvý ne-googlovský odkaz.
  return firstExternalUrl(txt);
}

function cleanText(text) {
  return (text || "").replace(/\s+/g, " ").trim();
}

function denorm(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function isoFromParts(year, month, day, hour = 0, minute = 0, second = 0) {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    return null;
  }

  const dt = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }
  return dt.toISOString();
}

function isReasonableDate(iso) {
  const year = new Date(iso).getUTCFullYear();
  const maxYear = new Date().getUTCFullYear() + 1;
  return year >= 2000 && year <= maxYear;
}

function parseDateValue(value) {
  const text = cleanText(String(value || ""));
  if (!text) return null;

  const slovak = text.match(
    /\b([0-3]?\d)\.\s*([\p{L}]+)\s+((?:19|20)\d{2})(?:\s+(?:o\s*)?([0-2]?\d):([0-5]\d)(?::([0-5]\d))?)?/iu
  );
  if (slovak) {
    const month = MONTHS_SK.get(denorm(slovak[2]));
    if (month) {
      return isoFromParts(
        Number(slovak[3]),
        month,
        Number(slovak[1]),
        slovak[4] ? Number(slovak[4]) : 0,
        slovak[5] ? Number(slovak[5]) : 0,
        slovak[6] ? Number(slovak[6]) : 0
      );
    }
  }

  const numeric = text.match(
    /\b([0-3]?\d)\.\s*([01]?\d)\.\s*((?:19|20)\d{2})(?:\s+(?:o\s*)?([0-2]?\d):([0-5]\d)(?::([0-5]\d))?)?/u
  );
  if (numeric) {
    return isoFromParts(
      Number(numeric[3]),
      Number(numeric[2]),
      Number(numeric[1]),
      numeric[4] ? Number(numeric[4]) : 0,
      numeric[5] ? Number(numeric[5]) : 0,
      numeric[6] ? Number(numeric[6]) : 0
    );
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return null;
}

function addDateCandidate(candidates, value, score, source) {
  if (Array.isArray(value)) {
    for (const v of value) addDateCandidate(candidates, v, score, source);
    return;
  }
  if (!value) return;

  const iso = parseDateValue(value);
  if (!iso || !isReasonableDate(iso)) return;
  candidates.push({ iso, score, source });
}

function jsonLdTypes(node) {
  const raw = node?.["@type"];
  if (Array.isArray(raw)) return raw.map(String);
  return raw ? [String(raw)] : [];
}

function walkJsonLd(node, candidates) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) walkJsonLd(item, candidates);
    return;
  }
  if (typeof node !== "object") return;

  const isArticle = jsonLdTypes(node).some((type) =>
    /(?:news)?article|blogposting/i.test(type)
  );
  const base = isArticle ? 150 : 95;

  addDateCandidate(candidates, node.datePublished, base, "json-ld datePublished");
  addDateCandidate(candidates, node.dateCreated, base - 10, "json-ld dateCreated");
  addDateCandidate(candidates, node.uploadDate, base - 20, "json-ld uploadDate");
  addDateCandidate(candidates, node.dateModified, base - 70, "json-ld dateModified");

  for (const value of Object.values(node)) {
    if (value && typeof value === "object") walkJsonLd(value, candidates);
  }
}

function readJsonLd(document, candidates) {
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    const raw = script.textContent?.trim();
    if (!raw) continue;
    try {
      walkJsonLd(JSON.parse(raw), candidates);
    } catch {
      // Niektore weby vkladaju nevalidny JSON-LD. Ostatne zdroje datumu stacia.
    }
  }
}

function readMetaDates(document, candidates) {
  const selectors = [
    ['meta[property="article:published_time"]', 140, "article:published_time"],
    ['meta[name="article:published_time"]', 140, "article:published_time"],
    ['meta[property="og:published_time"]', 130, "og:published_time"],
    ['meta[name="datePublished"]', 130, "datePublished"],
    ['meta[itemprop="datePublished"]', 130, "itemprop datePublished"],
    ['meta[name="pubdate"]', 120, "pubdate"],
    ['meta[name="publishdate"]', 120, "publishdate"],
    ['meta[name="publish-date"]', 120, "publish-date"],
    ['meta[name="sailthru.date"]', 120, "sailthru.date"],
    ['meta[name="parsely-pub-date"]', 120, "parsely-pub-date"],
    ['meta[name="DC.date.issued"]', 115, "DC.date.issued"],
    ['meta[name="dc.date.issued"]', 115, "dc.date.issued"],
    ['meta[name="date"]', 80, "date"],
    ['meta[property="article:modified_time"]', 60, "article:modified_time"],
    ['meta[property="og:updated_time"]', 55, "og:updated_time"],
  ];

  for (const [selector, score, source] of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      addDateCandidate(candidates, el.getAttribute("content"), score, source);
    }
  }
}

function readTimeDates(document, candidates) {
  for (const el of document.querySelectorAll("[datetime], [itemprop='datePublished']")) {
    const raw =
      el.getAttribute("datetime") ||
      el.getAttribute("content") ||
      el.textContent;
    const sourceText = denorm(
      `${el.getAttribute("itemprop") || ""} ${el.className || ""} ${el.id || ""}`
    );
    const score = sourceText.includes("datepublished") ? 125 : 90;
    addDateCandidate(candidates, raw, score, "time datetime");
  }
}

function textDateScore(text, index, raw, titleIndexes) {
  let score = 25;
  const nearestTitle = titleIndexes.length
    ? Math.min(...titleIndexes.map((i) => Math.abs(index - i)))
    : Infinity;

  if (nearestTitle < 140) score += 90;
  else if (nearestTitle < 400) score += 70;
  else if (nearestTitle < 1000) score += 45;
  else if (nearestTitle < 2500) score += 20;

  if (index < text.length * 0.35) score += 15;

  const before = denorm(text.slice(Math.max(0, index - 90), index));
  const around = denorm(text.slice(Math.max(0, index - 120), index + raw.length + 120));

  if (/(publik|zverejn|vydan|datum|autor|redakcia)/.test(around)) score += 45;
  if (/(min citania|citani)/.test(around)) score += 50;
  if (/aktualiz/.test(around)) score += 15;
  if (/(najcitanejsie|najsledovanejsie|odporucame|dalsie clanky|diskusia|komentar)/.test(around)) {
    score -= 60;
  }
  if (/(pondelok|utorok|streda|stvrtok|piatok|sobota|nedela),?\s*$/.test(before)) {
    score -= 45;
  }

  return score;
}

function addTextDateCandidates(document, candidates) {
  const text = cleanText(document.body?.textContent || document.textContent || "");
  if (!text) return;

  const titleIndexes = Array.from(document.querySelectorAll("h1"))
    .map((h) => cleanText(h.textContent))
    .filter(Boolean)
    .map((title) => text.indexOf(title))
    .filter((idx) => idx >= 0);

  const patterns = [
    /\b([0-3]?\d)\.\s*([\p{L}]+)\s+((?:19|20)\d{2})(?:\s+(?:o\s*)?([0-2]?\d):([0-5]\d)(?::([0-5]\d))?)?/giu,
    /\b([0-3]?\d)\.\s*([01]?\d)\.\s*((?:19|20)\d{2})(?:\s+(?:o\s*)?([0-2]?\d):([0-5]\d)(?::([0-5]\d))?)?/gu,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text))) {
      const score = textDateScore(text, match.index, match[0], titleIndexes);
      addDateCandidate(candidates, match[0], score, "text near headline");
    }
  }
}

function extractPublishedAt(document) {
  const candidates = [];
  readJsonLd(document, candidates);
  readMetaDates(document, candidates);
  readTimeDates(document, candidates);
  addTextDateCandidates(document, candidates);

  candidates.sort((a, b) => b.score - a.score || new Date(a.iso) - new Date(b.iso));
  return candidates[0]?.iso || null;
}

/** Stiahne reálnu URL a vytiahne text + metadáta článku. */
async function extractArticle(url, signal) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal });
  if (!res.ok) return { body: "", publishedAt: null };
  const ctype = res.headers.get("content-type") || "";
  if (!ctype.includes("text/html")) return { body: "", publishedAt: null };
  const html = await res.text();
  try {
    const { document } = parseHTML(html);
    const publishedAt = extractPublishedAt(document);
    const article = new Readability(document, { charThreshold: 200 }).parse();
    const text = article?.textContent || "";
    return { body: cleanText(text), publishedAt };
  } catch {
    return { body: "", publishedAt: null };
  }
}

/**
 * Pre jeden článok získa text tela (alebo "" pri neúspechu).
 * @param {string} gnLink  odkaz z Google News RSS
 * @param {number} timeoutMs  strop na celý proces (resolve + fetch)
 */
export async function fetchArticleBody(gnLink, timeoutMs = 12000) {
  const ctrl = AbortSignal.timeout(timeoutMs);
  const fallbackUrl = googleNewsWebUrl(gnLink);
  try {
    const isGoogleNews = Boolean(googleNewsArticleId(gnLink));
    const real = isGoogleNews ? await resolveGoogleNewsUrl(gnLink, ctrl) : gnLink;
    if (!real) {
      return { url: null, googleNewsUrl: fallbackUrl, body: "", publishedAt: null };
    }
    const article = await extractArticle(real, ctrl);
    return { url: real, googleNewsUrl: fallbackUrl, ...article };
  } catch {
    return { url: null, googleNewsUrl: fallbackUrl, body: "", publishedAt: null };
  }
}

/** Priame stiahnutie článku bez rozbaľovania Google News odkazu. */
export async function fetchDirectArticle(url, timeoutMs = 12000) {
  const ctrl = AbortSignal.timeout(timeoutMs);
  try {
    const article = await extractArticle(url, ctrl);
    return { url, ...article };
  } catch {
    return { url, body: "", publishedAt: null };
  }
}

/**
 * Stiahne telá viacerých článkov s obmedzenou súbežnosťou (šetrný k zdrojom).
 * @param {Array<{link:string}>} items
 * @param {{concurrency?:number, timeoutMs?:number}} opts
 * @returns {Promise<Map<string,{url:string|null, googleNewsUrl:string, body:string}>>} link -> výsledok
 */
export async function fetchArticleBodies(items, opts = {}) {
  const concurrency = opts.concurrency ?? 6;
  const timeoutMs = opts.timeoutMs ?? 12000;
  const results = new Map();
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const it = items[idx++];
      if (!it.link) {
        results.set(it.link, { url: null, body: "", publishedAt: null });
        continue;
      }
      results.set(it.link, await fetchArticleBody(it.link, timeoutMs));
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  );
  return results;
}
