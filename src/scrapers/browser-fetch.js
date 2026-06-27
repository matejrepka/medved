// Načítanie JSON dát z webu chráneného Cloudflare výzvou ("Just a moment...").
//
// Obyčajný fetch takúto výzvu neprejde — vyžaduje vykonanie JavaScriptu v
// prehliadači. Preto spustíme headless Chromium (Playwright): najprv otvoríme
// domovskú stránku a počkáme, kým Cloudflare výzvu vyrieši (nastaví cf_clearance
// cookie). Potom dáta sťahujeme cez `fetch` priamo v kontexte stránky — rovnaký
// pôvod, tie isté cookies a odtlačok prehliadača, takže výzva už nezasiahne.
//
// Playwright a Chromium sa načítavajú lenivo (dynamický import v tumedved.js),
// aby zvyšok aplikácie bežal aj keď prehliadač nie je nainštalovaný.

import { chromium } from "playwright";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CHALLENGE_TITLE = /just a moment|attention required|access denied/i;

/** Počká, kým prehliadač prejde Cloudflare výzvou (alebo vyprší čas). */
async function waitForClearance(page, deadline) {
  while (Date.now() < deadline) {
    const title = await page.title().catch(() => "");
    if (!CHALLENGE_TITLE.test(title)) return;
    await page.waitForTimeout(1000);
  }
  throw new Error("Cloudflare výzvu sa nepodarilo prejsť (timeout)");
}

/**
 * Stiahne postupne stránkované JSON cez headless prehliadač.
 * @param {Object} opts
 * @param {string} opts.homeUrl   stránka, na ktorej prejdeme Cloudflare výzvou
 * @param {(page:number)=>string} opts.pageUrl  URL pre danú stránku dát
 * @param {number} opts.maxPages  bezpečnostný strop na počet stránok
 * @param {number} opts.perPage   položiek na stránku (na detekciu poslednej)
 * @param {number} [opts.timeoutMs=45000]
 * @returns {Promise<Array>} zlúčené surové položky zo všetkých stránok
 */
export async function fetchJsonPagesViaBrowser({
  homeUrl,
  pageUrl,
  maxPages,
  perPage,
  timeoutMs = 45000,
}) {
  const deadline = Date.now() + timeoutMs;
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  try {
    const context = await browser.newContext({
      userAgent: UA,
      locale: "sk-SK",
      viewport: { width: 1366, height: 768 },
    });
    const page = await context.newPage();

    await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await waitForClearance(page, deadline);

    const all = [];
    for (let p = 1; p <= maxPages; p++) {
      const url = pageUrl(p);
      // Fetch vo vnútri stránky → použije cf_clearance cookie aj odtlačok prehliadača.
      const result = await page.evaluate(async (u) => {
        const r = await fetch(u, {
          headers: { Accept: "application/json" },
          credentials: "include",
        });
        return {
          status: r.status,
          totalPages: Number(r.headers.get("x-wp-totalpages")) || 0,
          text: await r.text(),
        };
      }, url);

      if (result.status === 400) break; // za poslednou stránkou
      if (result.status !== 200) {
        throw new Error(`tumedved.sk vrátil HTTP ${result.status}`);
      }

      let batch;
      try {
        batch = JSON.parse(result.text);
      } catch {
        throw new Error("tumedved.sk: neplatná JSON odpoveď (možno Cloudflare výzva)");
      }
      if (!Array.isArray(batch) || batch.length === 0) break;

      all.push(...batch);

      if (result.totalPages && p >= result.totalPages) break;
      if (batch.length < perPage) break;
    }

    return all;
  } finally {
    await browser.close();
  }
}
