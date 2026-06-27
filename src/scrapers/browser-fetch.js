// Načítanie JSON dát z webu chráneného Cloudflare výzvou ("Just a moment...").
//
// Obyčajný fetch takúto výzvu neprejde — vyžaduje vykonanie JavaScriptu v
// prehliadači. Preto spustíme Chromium cez Playwright so „stealth“ úpravami,
// otvoríme domovskú stránku a počkáme, kým Cloudflare vydá cookie `cf_clearance`.
// Potom dáta sťahujeme cez `fetch` priamo v kontexte stránky (rovnaký pôvod,
// tie isté cookies aj odtlačok prehliadača), takže výzva už nezasiahne.
//
// POZOR: tumedved.sk používa Cloudflare „Managed Challenge“ + Turnstile, ktorý
// je navrhnutý práve proti automatizácii. Aj so stealth pluginom je úspešnosť
// kolísavá — preto skúšame viackrát. Na serveri bez obrazovky (Linux) treba
// bežať buď headless (TUMEDVED_BROWSER_HEADLESS=true, predvolené), alebo cez
// xvfb-run, ak by sa ukázalo, že headed prechádza spoľahlivejšie.

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

chromium.use(StealthPlugin());

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const HEADLESS = process.env.TUMEDVED_BROWSER_HEADLESS !== "false";
const ATTEMPTS = Number(process.env.TUMEDVED_BROWSER_ATTEMPTS) || 3;

/** Počká, kým Cloudflare vydá cookie cf_clearance (= výzva prešla). */
async function waitForClearance(context, page, deadline) {
  while (Date.now() < deadline) {
    const cleared = (await context.cookies()).some((c) => c.name === "cf_clearance");
    if (cleared) {
      // Necháme stránku dobehnúť na reálny obsah po vydaní cookie.
      await page.waitForTimeout(2500);
      return true;
    }
    await page.waitForTimeout(1000);
  }
  return false;
}

/** Jeden pokus: otvor prehliadač, prejdi výzvou a stiahni všetky stránky. */
async function attemptFetch({ homeUrl, pageUrl, maxPages, perPage, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  const browser = await chromium.launch({
    headless: HEADLESS,
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

    await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs }).catch(() => {});
    if (!(await waitForClearance(context, page, deadline))) {
      throw new Error("Cloudflare výzvu sa nepodarilo prejsť (cf_clearance)");
    }

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

/**
 * Stiahne postupne stránkované JSON cez headless prehliadač. Skúša viackrát,
 * keďže Cloudflare Managed Challenge je voči automatizácii nestabilná.
 * @param {Object} opts
 * @param {string} opts.homeUrl   stránka, na ktorej prejdeme Cloudflare výzvou
 * @param {(page:number)=>string} opts.pageUrl  URL pre danú stránku dát
 * @param {number} opts.maxPages  bezpečnostný strop na počet stránok
 * @param {number} opts.perPage   položiek na stránku (na detekciu poslednej)
 * @param {number} [opts.timeoutMs=60000]  strop na jeden pokus
 * @returns {Promise<Array>} zlúčené surové položky zo všetkých stránok
 */
export async function fetchJsonPagesViaBrowser(opts) {
  const timeoutMs = opts.timeoutMs ?? 60000;
  let lastErr;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      return await attemptFetch({ ...opts, timeoutMs });
    } catch (err) {
      lastErr = err;
      console.warn(`[tumedved] prehliadačový pokus ${attempt}/${ATTEMPTS} zlyhal: ${err.message}`);
    }
  }
  throw lastErr || new Error("tumedved.sk: prehliadačové sťahovanie zlyhalo");
}
