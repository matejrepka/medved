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

/**
 * Rozbalí zakódovaný odkaz Google News na reálnu URL článku.
 * Postup: stiahne stránku článku (kvôli podpisu sg/ts), potom zavolá interné
 * Google "batchexecute" RPC, ktoré vráti cieľovú adresu. Ak čokoľvek zlyhá,
 * vráti null a volajúci použije nadpis/snippet.
 */
async function resolveGoogleNewsUrl(gnUrl, signal) {
  const id = gnUrl.split("/articles/")[1]?.split("?")[0];
  if (!id) return null;

  const page = await fetch(`https://news.google.com/rss/articles/${id}`, {
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
  // V odpovedi je cieľová URL ako prvý http(s) odkaz.
  const m = txt.match(/"(https?:\/\/[^"\\]+)"/);
  return m ? m[1] : null;
}

/** Stiahne reálnu URL a Readability-om vytiahne čistý text článku. */
async function extractArticleText(url, signal) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal });
  if (!res.ok) return "";
  const ctype = res.headers.get("content-type") || "";
  if (!ctype.includes("text/html")) return "";
  const html = await res.text();
  try {
    const { document } = parseHTML(html);
    const article = new Readability(document, { charThreshold: 200 }).parse();
    const text = article?.textContent || "";
    return text.replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

/**
 * Pre jeden článok získa text tela (alebo "" pri neúspechu).
 * @param {string} gnLink  odkaz z Google News RSS
 * @param {number} timeoutMs  strop na celý proces (resolve + fetch)
 */
export async function fetchArticleBody(gnLink, timeoutMs = 12000) {
  const ctrl = AbortSignal.timeout(timeoutMs);
  try {
    const real = await resolveGoogleNewsUrl(gnLink, ctrl);
    if (!real) return { url: null, body: "" };
    const body = await extractArticleText(real, ctrl);
    return { url: real, body };
  } catch {
    return { url: null, body: "" };
  }
}

/**
 * Stiahne telá viacerých článkov s obmedzenou súbežnosťou (šetrný k zdrojom).
 * @param {Array<{link:string}>} items
 * @param {{concurrency?:number, timeoutMs?:number}} opts
 * @returns {Promise<Map<string,{url:string|null, body:string}>>} link -> výsledok
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
        results.set(it.link, { url: null, body: "" });
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
