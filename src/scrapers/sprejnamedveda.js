import crypto from "node:crypto";
import { parseHTML } from "linkedom";

const MAP_URL = "https://www.sprejnamedveda.sk/medvede-na-mape/";
const DATA_URL = "https://www.sprejnamedveda.sk/mapa-2/";
const POSTS_URL = "https://www.sprejnamedveda.sk/wp-json/wp/v2/posts";
const USER_AGENT = "Mozilla/5.0 (compatible; KdeJeMedved/1.0; +https://kdejemedved.sk)";

function dateOnlyToIso(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2})$/);
  return match ? `${match[1]}T12:00:00.000Z` : null;
}

function extractImportedArticle(value) {
  return String(value || "").replace(/\s+/g, " ").trim().match(
    /(?:[ČC]l[aá]nok):\s*(.+?)(?=\.\s*(?:Odpor[uú][čc]anie):|$)/iu
  )?.[1]?.trim() || "";
}

function extractSourceNote(value) {
  return String(value || "").replace(/\s+/g, " ").trim().match(
    /Pozn[aá]mka zo zdroja:\s*(.+)$/iu
  )?.[1]?.trim() || "";
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLocaleLowerCase("sk-SK")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function htmlText(value) {
  const { document } = parseHTML(`<span>${String(value || "")}</span>`);
  return String(document.querySelector("span")?.textContent || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function articleKey(location, date) {
  return `${normalizeSearchText(location)}|${date}`;
}

function hasBearReference(value) {
  return /\bmedved|\bmedvied/u.test(normalizeSearchText(value));
}

function articleMentionsLocation(articleTitle, location) {
  const articleTokens = new Set(normalizeSearchText(articleTitle).split(" ").filter(Boolean));
  const locationTokens = normalizeSearchText(location)
    .split(" ")
    .filter((token) => token.length >= 4);
  return locationTokens.length > 0 && locationTokens.some((token) => articleTokens.has(token));
}

export function buildSprejnamedvedaArticleIndex(posts = []) {
  const index = new Map();
  for (const post of posts) {
    const title = htmlText(post?.title?.rendered);
    const match = title.match(
      /^Výskyt medveďa:\s*(.+?)\s+[–-]\s+(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})$/iu
    );
    if (!match || !post?.link) continue;
    const date = `${match[4]}-${match[3].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
    const article = {
      url: String(post.link),
      title,
      excerpt: htmlText(post?.excerpt?.rendered),
    };
    index.set(articleKey(match[1], date), article);
    const withoutPlacePrefix = match[1].replace(/^(?:obec|mesto)\s+/iu, "");
    index.set(articleKey(withoutPlacePrefix, date), article);
  }
  return index;
}

export function isRelevantSprejnamedvedaRow(row, article = null) {
  const description = String(row?.description || "").replace(/\s+/g, " ").trim();
  const importedArticle = extractImportedArticle(description);
  if (importedArticle) {
    return Boolean(article?.url) &&
      hasBearReference(importedArticle) &&
      articleMentionsLocation(importedArticle, row?.location || row?.title);
  }
  if (/^Draft import\s+\d{4}\./iu.test(description)) return Boolean(article?.url);
  if (
    /^Automaticky zachyteny kandidat (?:z verejnej mapy )?na rucnu kontrolu/iu.test(description)
  ) return Boolean(extractSourceNote(description) || article?.url);
  return true;
}

export function cleanSprejnamedvedaDescription(value) {
  const compact = String(value || "").replace(/\s+/g, " ").trim();
  if (!compact) return "";

  // Časť bodov na zdrojovej mape obsahuje interný text z importu. Návštevníkovi
  // patrí iba pôvodná poznámka alebo názov upozornenia, nie pokyny pre redakciu.
  const sourceNote = extractSourceNote(compact);
  if (sourceNote) return sourceNote;

  const article = extractImportedArticle(compact);
  if (article) return "";

  if (
    /^Draft import\s+\d{4}\./iu.test(compact) ||
    /^Automaticky zachyteny kandidat (?:z verejnej mapy )?na rucnu kontrolu/iu.test(compact)
  ) return "";

  const parts = String(value || "")
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  const specific = parts.filter((part) =>
    !/^V lokalite .+ bol zaznamenaný výskyt medveďa zo dňa \d{4}-\d{2}-\d{2}\.?$/iu.test(part)
  );
  const meaningful = specific.filter((part) =>
    !/^V\s+(?:pondelok|utorok|stredu|štvrtok|piatok|sobotu|nedeľu)\s+\d{1,2}\.?$/iu.test(part)
  );
  return meaningful.join("\n\n");
}

function cleanArticleExcerpt(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(
      /^Výskyt medveďa v lokalite .+? zo dňa \d{1,2}\.\s*\d{1,2}\.\s*\d{4}\.?\s*/iu,
      ""
    );
}

function stableId(item) {
  const key = [item.location, item.observed_at, item.lat, item.lng, item.description]
    .map((value) => String(value || "").trim())
    .join("|");
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 20);
}

export function normalizeSprejnamedvedaRow(row, article = null) {
  if (!isRelevantSprejnamedvedaRow(row, article)) return null;
  const id = stableId(row);
  const lat = Number(row.lat);
  const lng = Number(row.lng);
  const articleUrl = article?.url ? String(article.url) : null;
  const note = cleanSprejnamedvedaDescription(row.description) || cleanArticleExcerpt(article?.excerpt);
  const sourceLinks = articleUrl
    ? [
        {
          key: "sprejnamedveda",
          label: "sprejnamedveda.sk – článok",
          url: articleUrl,
          sourceId: id,
        },
        {
          key: "sprejnamedveda",
          label: "sprejnamedveda.sk – mapa",
          url: MAP_URL,
          sourceId: id,
        },
      ]
    : [
        {
          key: "sprejnamedveda",
          label: "sprejnamedveda.sk",
          url: MAP_URL,
          sourceId: id,
        },
      ];
  return {
    id: `sprejnamedveda-${id}`,
    source: "sprejnamedveda.sk",
    sourceKey: "sprejnamedveda",
    location: row.location || row.title || "Lokalita neuvedená",
    note,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    hasCoords: Number.isFinite(lat) && Number.isFinite(lng),
    reportedAt: dateOnlyToIso(row.observed_at),
    datePrecision: "date",
    url: articleUrl || MAP_URL,
    sourceLinks,
  };
}

async function fetchArticleIndex(sightings) {
  const years = sightings
    .map((item) => Number(String(item?.observed_at || "").slice(0, 4)))
    .filter(Number.isInteger);
  if (!years.length) return new Map();

  const params = new URLSearchParams({
    categories: "1",
    after: `${Math.min(...years)}-01-01T00:00:00`,
    before: `${Math.max(...years) + 1}-01-01T00:00:00`,
    per_page: "100",
    orderby: "id",
    order: "desc",
    _fields: "link,title,excerpt",
  });
  const fetchPage = async (page) => {
    const response = await fetch(`${POSTS_URL}?${params}&page=${page}`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`API článkov vrátilo HTTP ${response.status}`);
    return { posts: await response.json(), pages: Number(response.headers.get("x-wp-totalpages")) || 1 };
  };

  const first = await fetchPage(1);
  const pageCount = Math.min(first.pages, 10);
  const rest = pageCount > 1
    ? await Promise.all(Array.from({ length: pageCount - 1 }, (_, index) => fetchPage(index + 2)))
    : [];
  return buildSprejnamedvedaArticleIndex([
    ...first.posts,
    ...rest.flatMap((page) => page.posts),
  ]);
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
  let articleIndex = new Map();
  try {
    articleIndex = await fetchArticleIndex(sightings);
  } catch (err) {
    console.warn(`[sprejnamedveda] konkrétne články sa nepodarilo načítať: ${err.message}`);
  }
  return sightings
    .map((row) => normalizeSprejnamedvedaRow(row, articleIndex.get(articleKey(row.location, row.observed_at))))
    .filter((item) => item?.reportedAt);
}
