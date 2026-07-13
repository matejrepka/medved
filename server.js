// Medveď Sledovač — server.
//
// Dáta sa sťahujú výhradne cez externý cron job (cron-job.org), ktorý volá
// /api/cron/refresh. Server pri štarte načíta existujúce dáta
// zo Supabase a servíruje ich cez JSON API + frontend zo zložky /public.

import "dotenv/config";
import express from "express";
import compression from "compression";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, stat } from "node:fs/promises";

import { fetchTumedved } from "./src/scrapers/tumedved.js";
import { fetchNews } from "./src/scrapers/news.js";
import { ScheduledDataStore } from "./src/scheduled-store.js";
import { classifyFreshNews } from "./src/ai/news-classifier.js";
import { loadPlaces, lookupPlaceByName } from "./src/geo/geocode.js";
import { isSlovakCoordinate, searchSlovakLocations } from "./src/geo/search.js";
import { buildStatsReport } from "./src/stats-report.js";
import { isSupabaseConfigured } from "./src/db/supabase.js";
import {
  deleteEmailSubscription,
  hashIp,
  loadAllNews,
  loadAllSightings,
  loadApprovedBearReports,
  loadBearReports,
  loadEmailSubscriptions,
  loadNewsLogs,
  loadPendingNews,
  loadPendingSightings,
  loadTumedvedLogs,
  recordScrapeRun,
  saveBearReport,
  saveEmailSubscription,
  saveManualNews,
  saveManualTumedved,
  saveNewsLogs,
  saveTumedvedLogs,
  saveWebsiteLog,
  updateBearReportStatus,
  updateNewsFields,
  updateNewsStatus,
  updateSightingFields,
  updateSightingStatus,
  reviewNews,
} from "./src/db/repository.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = process.env.PORT || 3000;
const CRON_REFRESH_SECRET = process.env.CRON_REFRESH_SECRET;

function normalizeSiteOrigin(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value).trim());
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

const CONFIGURED_SITE_ORIGIN = normalizeSiteOrigin(process.env.SITE_URL);

const PUBLIC_PAGES = {
  "/": {
    file: "index.html",
    title: "Aktuálna mapa výskytu medveďov na Slovensku | Kde je Medveď",
    description:
      "Aktuálna mapa hláseného výskytu medveďov na Slovensku. Moderované hlásenia, správy, dátumy, lokality a bezpečnostné odporúčania na jednom mieste.",
    schemaType: "CollectionPage",
    priority: "1.0",
  },
  "/stats": {
    file: "stats.html",
    title: "Štatistiky výskytu medveďov na Slovensku | Kde je Medveď",
    description:
      "Aktuálne štatistiky hlásení výskytu medveďov na Slovensku: vývoj v čase, najčastejšie lokality a čas hlásení.",
    schemaType: "CollectionPage",
    changefreq: "daily",
    priority: "0.8",
  },
  "/nahlas": {
    file: "nahlas.html",
    title: "Nahlásiť výskyt medveďa na Slovensku | Kde je Medveď",
    description:
      "Nahláste pozorovanie medveďa na Slovensku, označte miesto na mape a doplňte čas a okolnosti. Hlásenie pred zverejnením skontrolujeme.",
    schemaType: "WebPage",
    changefreq: "monthly",
    priority: "0.7",
  },
  "/bezpecnost": {
    file: "bezpecnost.html",
    title: "Čo robiť pri stretnutí s medveďom | Oficiálne odporúčania",
    description:
      "Stručný postup pri stretnutí alebo útoku medveďa podľa odporúčaní Zásahového tímu ŠOP SR. Prevencia, tiesňová linka 112 a dôležité kontakty.",
    schemaType: "Article",
    changefreq: "monthly",
    priority: "0.9",
  },
  "/o-mape": {
    file: "o-mape.html",
    title: "O mape, zdroje a metodika údajov | Kde je Medveď",
    description:
      "Ako vzniká mapa výskytu medveďov: zdroje údajov, moderovanie, aktualizácia, práca s polohou a obmedzenia hlásení.",
    schemaType: "AboutPage",
    changefreq: "monthly",
    priority: "0.7",
  },
  "/privacy": {
    file: "privacy.html",
    title: "Ochrana súkromia | Kde je Medveď",
    description: "Informácie o ochrane súkromia pri používaní služby Kde je Medveď.",
    schemaType: "WebPage",
    changefreq: "yearly",
    priority: "0.2",
  },
  "/terms": {
    file: "terms.html",
    title: "Podmienky používania | Kde je Medveď",
    description: "Podmienky používania mapy a služby Kde je Medveď.",
    schemaType: "WebPage",
    changefreq: "yearly",
    priority: "0.2",
  },
};

const pageTemplateCache = new Map();

function siteOrigin(req) {
  if (CONFIGURED_SITE_ORIGIN) return CONFIGURED_SITE_ORIGIN;
  const host = req.get("host") || `localhost:${PORT}`;
  // Host sa zapisuje do HTML, preto povoľ iba znaky platné v hostname/porte.
  const safeHost = /^[a-z0-9.:[\]-]+$/i.test(host) ? host : `localhost:${PORT}`;
  return normalizeSiteOrigin(`${req.protocol}://${safeHost}`) || `http://localhost:${PORT}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function absoluteUrl(origin, pathname = "/") {
  return new URL(pathname, `${origin}/`).toString();
}

function latestContentDate() {
  return [sightingsStore.meta.fetchedAt, newsStore.meta.fetchedAt]
    .filter(Boolean)
    .sort()
    .pop() || null;
}

function faqEntities() {
  return [
    {
      question: "Je mapa výskytu medveďov aktuálna?",
      answer:
        "Dáta sa automaticky kontrolujú. Na mape sa zobrazia až položky, ktoré prešli moderovaním; čas poslednej aktualizácie je uvedený priamo na stránke.",
    },
    {
      question: "Znamená bod na mape, že medveď je stále na danom mieste?",
      answer:
        "Nie. Bod označuje miesto a čas nahláseného pozorovania alebo varovania. Medvede sa pohybujú a môžu sa vyskytnúť aj mimo vyznačených miest.",
    },
    {
      question: "Sú hlásenia na mape overené?",
      answer:
        "Hlásenia sú kontrolované iba z hľadiska spamu. Jednotlivé pozorovania a varovania pochádzajú od používateľov, z iných webových stránok a zo správ; nejde o profesionálne ani terénne overené informácie.",
    },
    {
      question: "Ako nahlásiť výskyt medveďa?",
      answer:
        "Kontaktovať Zásahový tím pre medveďa hnedého ŠOP SR. Ak chcete nahlásiť výskyt do tejto mapy, použite formulár na nahlásenie výskytu.",
      answerUrl: "https://zasahovytim.sopsr.sk/",
    },
    {
      question: "Čo robiť, keď stretnem medveďa?",
      answer: "Bezpečnosť – Zásahový tím pre medveďa hnedého ŠOP SR",
      answerUrl: "https://zasahovytim.sopsr.sk/bezpecnost/",
    },
  ];
}

function structuredDataForPage(pathname, page, origin) {
  const canonical = absoluteUrl(origin, pathname);
  const websiteId = `${origin}/#website`;
  const organizationId = `${origin}/#organization`;
  const modified = latestContentDate() || "2026-07-13T00:00:00+02:00";
  const graph = [
    {
      "@type": "Organization",
      "@id": organizationId,
      name: "Kde je Medveď",
      url: `${origin}/`,
      logo: {
        "@type": "ImageObject",
        url: absoluteUrl(origin, "/assets/mascot/bear-head-mark.png"),
        width: 256,
        height: 256,
      },
    },
    {
      "@type": "WebSite",
      "@id": websiteId,
      name: "Kde je Medveď",
      alternateName: "Mapa medveďov Slovensko",
      url: `${origin}/`,
      inLanguage: "sk-SK",
      publisher: { "@id": organizationId },
    },
    {
      "@type": page.schemaType,
      "@id": `${canonical}#webpage`,
      url: canonical,
      name: page.title,
      description: page.description,
      inLanguage: "sk-SK",
      isPartOf: { "@id": websiteId },
      dateModified: modified,
    },
  ];

  if (pathname !== "/") {
    graph.push({
      "@type": "BreadcrumbList",
      "@id": `${canonical}#breadcrumb`,
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Mapa", item: `${origin}/` },
        { "@type": "ListItem", position: 2, name: page.title.split("|")[0].trim(), item: canonical },
      ],
    });
  }

  if (pathname === "/") {
    graph.push(
      {
        "@type": "WebApplication",
        "@id": `${origin}/#application`,
        name: "Kde je Medveď – mapa výskytu medveďov",
        url: `${origin}/`,
        applicationCategory: "TravelApplication",
        operatingSystem: "Web",
        browserRequirements: "Requires JavaScript for the interactive map",
        inLanguage: "sk-SK",
        description: page.description,
        isAccessibleForFree: true,
        publisher: { "@id": organizationId },
      },
      {
        "@type": "Dataset",
        "@id": `${origin}/#dataset`,
        name: "Hlásený výskyt medveďov na Slovensku",
        description:
          "Priebežne aktualizovaný súbor moderovaných hlásení a verejných varovaní s dátumom, lokalitou a dostupnými súradnicami.",
        url: `${origin}/`,
        distribution: {
          "@type": "DataDownload",
          encodingFormat: "application/json",
          contentUrl: absoluteUrl(origin, "/api/warnings"),
        },
        spatialCoverage: { "@type": "Place", name: "Slovensko" },
        creator: { "@id": organizationId },
        inLanguage: "sk-SK",
        isAccessibleForFree: true,
        dateModified: modified,
        license: absoluteUrl(origin, "/terms"),
      },
      {
        "@type": "FAQPage",
        "@id": `${origin}/#faq`,
        mainEntity: faqEntities().map(({ question, answer, answerUrl }) => ({
          "@type": "Question",
          name: question,
          acceptedAnswer: {
            "@type": "Answer",
            text: answer,
            ...(answerUrl ? { url: answerUrl } : {}),
          },
        })),
      }
    );
  }

  if (pathname === "/bezpecnost") {
    const article = graph.find((item) => item["@id"] === `${canonical}#webpage`);
    Object.assign(article, {
      headline: "Čo robiť pri stretnutí s medveďom",
      author: { "@id": organizationId },
      publisher: { "@id": organizationId },
      datePublished: "2026-07-13T00:00:00+02:00",
      citation: [
        "https://zasahovytim.sopsr.sk/bezpecnost/",
        "https://zasahovytim.sopsr.sk/1887-2/",
      ],
    });
  }

  return { "@context": "https://schema.org", "@graph": graph };
}

function buildSeoHead(pathname, page, origin) {
  const canonical = absoluteUrl(origin, pathname);
  const image = absoluteUrl(origin, "/assets/mascot/bear-map-mascot-transparent.png");
  const schema = JSON.stringify(structuredDataForPage(pathname, page, origin)).replaceAll("<", "\\u003c");
  return [
    '<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1" />',
    `<link rel="canonical" href="${escapeHtml(canonical)}" />`,
    '<meta property="og:locale" content="sk_SK" />',
    '<meta property="og:type" content="website" />',
    '<meta property="og:site_name" content="Kde je Medveď" />',
    `<meta property="og:title" content="${escapeHtml(page.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(page.description)}" />`,
    `<meta property="og:url" content="${escapeHtml(canonical)}" />`,
    `<meta property="og:image" content="${escapeHtml(image)}" />`,
    '<meta property="og:image:width" content="700" />',
    '<meta property="og:image:height" content="700" />',
    '<meta property="og:image:alt" content="Ilustrácia medveďa pri mape Slovenska" />',
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:title" content="${escapeHtml(page.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(page.description)}" />`,
    `<meta name="twitter:image" content="${escapeHtml(image)}" />`,
    '<meta name="theme-color" content="#1f4b30" />',
    '<link rel="manifest" href="/manifest.webmanifest" />',
    '<link rel="alternate" type="application/rss+xml" title="Aktuálne hlásenia – Kde je Medveď" href="/feed.xml" />',
    `<script type="application/ld+json">${schema}</script>`,
  ].join("\n    ");
}

function formatSlovakDate(value, withTime = false) {
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) return "Dátum neuvedený";
  return new Intl.DateTimeFormat("sk-SK", {
    day: "numeric",
    month: "long",
    year: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
    timeZone: "Europe/Bratislava",
  }).format(date);
}

function renderSsrWarnings(items) {
  if (!items.length) return '<p class="empty">Hlásenia sa načítavajú…</p>';
  return items.slice(0, 15).map((item) => {
    const source = item.sourceType === "report" ? "moderované hlásenie" : item.source || "verejný zdroj";
    const note = item.note ? `<p class="card-note">${escapeHtml(String(item.note).slice(0, 240))}</p>` : "";
    const link = item.url
      ? `<a class="card-link" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">Detail pôvodného zdroja <span aria-hidden="true">→</span></a>`
      : "";
    return `<article class="card sighting" data-id="${escapeHtml(item.id)}">
      <h3 class="card-title">${escapeHtml(item.location || "Lokalita neuvedená")}</h3>
      <div class="card-meta"><span class="meta-source">${escapeHtml(source)}</span><time datetime="${escapeHtml(item.reportedAt || "")}">${escapeHtml(formatSlovakDate(item.reportedAt, true))}</time></div>
      ${note}${link}
    </article>`;
  }).join("\n");
}

function renderSsrNews(items) {
  if (!items.length) return '<p class="empty">Správy sa načítavajú…</p>';
  return items.slice(0, 12).map((item) => {
    const href = item.articleUrl || item.link || item.googleNewsUrl || "";
    const link = href
      ? `<a class="card-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">Prečítať správu <span aria-hidden="true">→</span></a>`
      : "";
    return `<article class="card news" data-id="${escapeHtml(item.id)}">
      <h3 class="card-title">${escapeHtml(item.title || "Správa o medveďovi")}</h3>
      <div class="card-meta"><span class="meta-source">${escapeHtml(item.source || "verejný zdroj")}</span><time datetime="${escapeHtml(item.date || "")}">${escapeHtml(formatSlovakDate(item.date))}</time></div>
      ${link}
    </article>`;
  }).join("\n");
}

async function getPageTemplate(file) {
  if (!pageTemplateCache.has(file)) {
    pageTemplateCache.set(file, await readFile(path.join(PUBLIC_DIR, file), "utf8"));
  }
  return pageTemplateCache.get(file);
}

const sightingsStore = new ScheduledDataStore({
  name: "tumedved",
  fetcher: fetchTumedved,
  loadStored: loadTumedvedLogs,
  saveFresh: saveTumedvedLogs,
  recordRun: recordScrapeRun,
});

const newsStore = new ScheduledDataStore({
  name: "news",
  fetcher: fetchNews,
  loadStored: loadNewsLogs,
  saveFresh: (items, scrapedAt) =>
    saveNewsLogs(items, scrapedAt, { prepareFresh: classifyFreshNews }),
  recordRun: recordScrapeRun,
});

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY === "true");

// Gzip/deflate odpovedí — JSON z API (až 1000 hlásení + 200 správ) aj
// HTML/CSS/JS sa prenášajú výrazne menšie (~70-85 %).
app.use(compression());

app.use(express.json());

// Základné bezpečnostné a indexačné hlavičky. Verejné JSON API ostáva dostupné,
// administračné a cron URL sa však nemajú objavovať vo výsledkoch vyhľadávania.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(self), camera=(), microphone=()");
  if (req.path === "/admin" || req.path.startsWith("/api/admin") || req.path.startsWith("/api/cron")) {
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  }
  next();
});

// Malý logger.
app.use((req, _res, next) => {
  if (req.path.startsWith("/api")) console.log(`${req.method} ${req.path}`);
  next();
});

function shouldLogWebsiteRequest(req) {
  if (req.path.startsWith("/api")) return true;
  return req.method === "GET" && ["/", "/privacy", "/terms", "/stats", "/nahlas"].includes(req.path);
}

app.use((req, res, next) => {
  const started = process.hrtime.bigint();

  res.on("finish", () => {
    if (!shouldLogWebsiteRequest(req)) return;

    const responseMs = Number((process.hrtime.bigint() - started) / 1000000n);
    saveWebsiteLog({
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      responseMs,
      userAgent: req.get("user-agent")?.slice(0, 1000),
      referer: req.get("referer")?.slice(0, 2000),
      ipHash: hashIp(req.ip || req.socket.remoteAddress),
    }).catch((err) => {
      console.error("[website_logs] insert failed:", err.message);
    });
  });

  next();
});

// --- API ---

app.get("/api/sightings", async (_req, res) => {
  try {
    const data = await sightingsStore.get();
    res.set("Cache-Control", "public, max-age=300");
    res.json({ updatedAt: sightingsStore.meta.fetchedAt, count: data.length, items: data });
  } catch (err) {
    res.status(502).json({ error: "Nepodarilo sa stiahnuť hlásenia z tumedved.sk", detail: err.message });
  }
});

// Zlúčený zoznam medvedích varovaní: scrapované hlásenia (tumedved) + schválené
// hlásenia od používateľov / manuálne pridané varovania. Každá položka nesie
// sourceType, nech frontend vie zobraziť pôvod (napr. štítok "tumedved.sk").
async function loadWarnings() {
  const [scraped, reports] = await Promise.all([
    sightingsStore.get(),
    loadApprovedBearReports().catch((err) => {
      console.error("[warnings] reports load failed:", err.message);
      return [];
    }),
  ]);

  return [
    ...scraped.map((item) => ({ sourceType: "tumedved", ...item })),
    ...reports,
  ].sort((a, b) => new Date(b.reportedAt || 0) - new Date(a.reportedAt || 0));
}

app.get("/api/warnings", async (_req, res) => {
  try {
    const items = await loadWarnings();
    // Krátka cache — schválené hlásenie sa má na webe objaviť rýchlo.
    res.set("Cache-Control", "public, max-age=60");
    res.json({ updatedAt: sightingsStore.meta.fetchedAt, count: items.length, items });
  } catch (err) {
    res.status(502).json({ error: "Nepodarilo sa načítať varovania", detail: err.message });
  }
});

app.get("/api/news", async (_req, res) => {
  try {
    const data = isSupabaseConfigured() ? await loadNewsLogs() : await newsStore.get();
    const scrapedTimes = data
      .map((item) => new Date(item._scrapedAt || 0).getTime())
      .filter((time) => Number.isFinite(time) && time > 0);
    const updatedAt =
      scrapedTimes.length > 0
        ? new Date(Math.max(...scrapedTimes)).toISOString()
        : newsStore.meta.fetchedAt;
    const items = data.map(({ _scrapedAt, ...item }) => item);

    res.set("Cache-Control", "no-store, max-age=0");
    res.json({ updatedAt, count: items.length, items });
  } catch (err) {
    res.status(502).json({ error: "Nepodarilo sa stiahnuť správy", detail: err.message });
  }
});

// Automatický štatistický report — počíta sa zo všetkých dát (nie len z toho,
// čo je na mape) a cez gazetteer nájde aj obce spomenuté len v texte správ.
app.get("/api/stats", async (_req, res) => {
  try {
    const [sightings, news, gz] = await Promise.all([
      loadWarnings(),
      newsStore.get(),
      loadPlaces(),
    ]);

    const report = buildStatsReport({ sightings, news, gz });
    const updatedAt =
      [sightingsStore.meta.fetchedAt, newsStore.meta.fetchedAt].filter(Boolean).sort().pop() || null;

    res.set("Cache-Control", "public, max-age=300");
    res.json({ updatedAt, ...report });
  } catch (err) {
    res.status(500).json({ error: "Nepodarilo sa zostaviť štatistiky", detail: err.message });
  }
});

// Stav serverového obnovovania dát.
app.get("/api/status", (_req, res) => {
  res.json({
    supabaseConfigured: isSupabaseConfigured(),
    refreshMode: "external-cron",
    sightings: sightingsStore.meta,
    news: newsStore.meta,
  });
});

function isValidCronRequest(req) {
  if (!CRON_REFRESH_SECRET) return false;
  const token = req.query.secret;
  return typeof token === "string" && token === CRON_REFRESH_SECRET;
}

// Obnoví obidva zdroje nezávisle. Keď jeden zlyhá (napr. tumedved.sk je za
// Cloudflare výzvou), druhý sa aj tak obnoví a uloží — a v odpovedi vidíme,
// ktorý zdroj zlyhal a prečo.
async function refreshAll(reason) {
  const [sightingsResult, newsResult] = await Promise.allSettled([
    sightingsStore.refresh(reason),
    newsStore.refresh(reason),
  ]);

  const errors = {};
  if (sightingsResult.status === "rejected") {
    errors.sightings = sightingsResult.reason?.message || String(sightingsResult.reason);
  }
  if (newsResult.status === "rejected") {
    errors.news = newsResult.reason?.message || String(newsResult.reason);
  }

  return {
    ok: sightingsResult.status === "fulfilled" || newsResult.status === "fulfilled",
    supabaseConfigured: isSupabaseConfigured(),
    refreshMode: "external-cron",
    sightings: sightingsStore.meta,
    news: newsStore.meta,
    errors: Object.keys(errors).length ? errors : null,
  };
}

app.all("/api/cron/refresh", async (req, res) => {
  if (!isValidCronRequest(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const result = await refreshAll("cron");
  res.status(result.ok ? 200 : 502).json({
    ...result,
    message: result.ok ? "Cron refresh completed." : "Cron refresh failed.",
  });
});

// --- Bear report (public) ---

app.post("/api/reports", async (req, res) => {
  const { location, description, reporterName, reporterEmail, lat, lng, reportedDate } = req.body || {};

  if (!location || typeof location !== "string" || !location.trim()) {
    return res.status(400).json({ ok: false, error: "Lokalita je povinná." });
  }

  try {
    const result = await saveBearReport({
      location: location.trim(),
      description: description?.trim() || null,
      reporterName: reporterName?.trim() || null,
      reporterEmail: reporterEmail?.trim() || null,
      lat: Number(lat) || null,
      lng: Number(lng) || null,
      reportedDate: reportedDate || new Date().toISOString(),
    });

    res.json({ ok: true, id: result?.id });
  } catch (err) {
    console.error("[reports] save failed:", err.message);
    res.status(500).json({ ok: false, error: "Nepodarilo sa uložiť hlásenie." });
  }
});

// --- Email subscriptions (public) ---

app.post("/api/subscriptions", async (req, res) => {
  const { email, notifyType, areaName } = req.body || {};

  if (!email || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res.status(400).json({ ok: false, error: "Zadajte platnú emailovú adresu." });
  }

  if (notifyType === "area" && (!areaName || !areaName.trim())) {
    return res.status(400).json({ ok: false, error: "Zadajte oblasť pre upozornenia." });
  }

  try {
    await saveEmailSubscription({
      email: email.trim().toLowerCase(),
      notifyType: notifyType === "area" ? "area" : "all",
      areaName: notifyType === "area" ? areaName.trim() : null,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("[subscriptions] save failed:", err.message);
    res.status(500).json({ ok: false, error: "Nepodarilo sa uložiť odber." });
  }
});

// --- Frontend + technické SEO ---

async function renderPublicPage(req, res, pathname, page) {
  try {
    const origin = siteOrigin(req);
    let html = await getPageTemplate(page.file);
    html = html.replace("<!-- SEO_HEAD -->", buildSeoHead(pathname, page, origin));

    // Domovská stránka dostane aj serverom vykreslené najnovšie dáta. Interaktívny
    // klient ich po načítaní prevezme, no crawlery a návštevníci bez JS už nevidia
    // prázdny app shell.
    if (pathname === "/") {
      const [warnings, news] = await Promise.all([
        loadWarnings().catch((err) => {
          console.error("[seo] warnings SSR failed:", err.message);
          return [];
        }),
        newsStore.get().catch((err) => {
          console.error("[seo] news SSR failed:", err.message);
          return [];
        }),
      ]);
      html = html
        .replace("<!-- SSR_WARNINGS -->", renderSsrWarnings(warnings))
        .replace("<!-- SSR_NEWS -->", renderSsrNews(news))
        .replace("<!-- SSR_UPDATED -->", escapeHtml(latestContentDate() || ""));
    }

    const canonical = absoluteUrl(origin, pathname);
    res.set({
      "Cache-Control": "no-cache",
      "Content-Language": "sk",
      Link: `<${canonical}>; rel="canonical"`,
    });
    const modified = latestContentDate();
    if (modified && pathname === "/") res.set("Last-Modified", new Date(modified).toUTCString());
    res.type("html").send(html);
  } catch (err) {
    console.error(`[frontend] ${pathname} render failed:`, err.message);
    res.status(500).type("text").send("Stránku sa nepodarilo načítať.");
  }
}

for (const [pathname, page] of Object.entries(PUBLIC_PAGES)) {
  app.get(pathname, (req, res) => renderPublicPage(req, res, pathname, page));
}

// Jednoznačná kanonická URL pre staré alebo opisné varianty adresy.
app.get(
  [
    "/index.html",
    "/mapa-vyskytu-medvedov",
    "/mapa-vyskytu-medvedov-na-slovensku",
  ],
  (_req, res) => res.redirect(301, "/")
);
for (const [pathname, page] of Object.entries(PUBLIC_PAGES)) {
  if (pathname !== "/") app.get(`/${page.file}`, (_req, res) => res.redirect(301, pathname));
}

app.get("/robots.txt", (req, res) => {
  const origin = siteOrigin(req);
  res
    .type("text/plain")
    .set("Cache-Control", "public, max-age=3600")
    .send([
      "User-agent: *",
      "Allow: /",
      "Disallow: /admin",
      "Disallow: /api/admin/",
      "Disallow: /api/cron/",
      "",
      `Sitemap: ${absoluteUrl(origin, "/sitemap.xml")}`,
      "",
    ].join("\n"));
});

app.get("/sitemap.xml", async (req, res) => {
  const origin = siteOrigin(req);
  const rows = await Promise.all(Object.entries(PUBLIC_PAGES).map(async ([pathname, page]) => {
    let lastmod;
    try {
      lastmod = (await stat(path.join(PUBLIC_DIR, page.file))).mtime.toISOString();
    } catch {
      lastmod = "2026-07-13T00:00:00.000Z";
    }
    if (pathname === "/" && latestContentDate()) lastmod = latestContentDate();
    const changefreq = page.changefreq
      ? `\n    <changefreq>${page.changefreq}</changefreq>`
      : "";
    return `  <url>\n    <loc>${escapeHtml(absoluteUrl(origin, pathname))}</loc>\n    <lastmod>${escapeHtml(lastmod)}</lastmod>${changefreq}\n    <priority>${page.priority}</priority>\n  </url>`;
  }));

  res
    .type("application/xml")
    .set("Cache-Control", "public, max-age=3600")
    .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join("\n")}\n</urlset>\n`);
});

// Stručný strojovo čitateľný opis pre generatívne vyhľadávače a asistentov.
// Nie je náhradou za HTML; odkazuje výhradne na rovnaký verejný obsah a API.
app.get("/llms.txt", (req, res) => {
  const origin = siteOrigin(req);
  res
    .type("text/plain")
    .set("Cache-Control", "public, max-age=3600")
    .send(`# Kde je Medveď

> Slovenská interaktívna mapa hláseného výskytu medveďov. Spája moderované hlásenia používateľov, verejné zdroje a relevantné slovenské správy.

## Najdôležitejšie stránky
- [Aktuálna mapa](${absoluteUrl(origin, "/")})
- [Štatistiky hlásení](${absoluteUrl(origin, "/stats")})
- [Bezpečnosť pri stretnutí s medveďom](${absoluteUrl(origin, "/bezpecnost")})
- [Zdroje, metodika a obmedzenia](${absoluteUrl(origin, "/o-mape")})
- [Nahlásiť pozorovanie](${absoluteUrl(origin, "/nahlas")})

## Strojovo čitateľné dáta
- [Aktuálne varovania – JSON](${absoluteUrl(origin, "/api/warnings")})
- [Aktuálne správy – JSON](${absoluteUrl(origin, "/api/news")})
- [Štatistiky – JSON](${absoluteUrl(origin, "/api/stats")})
- [RSS najnovších hlásení](${absoluteUrl(origin, "/feed.xml")})

## Dôležité obmedzenie
Bod na mape označuje miesto a čas nahláseného pozorovania alebo verejného varovania. Nejde o GPS sledovanie zvierat, potvrdenie ich aktuálnej polohy ani úplnú mapu populácie. Dáta sú orientačné a nenahrádzajú pokyny ŠOP SR, Zásahového tímu ani tiesňových zložiek.
`);
});

app.get("/feed.xml", async (req, res) => {
  const origin = siteOrigin(req);
  const warnings = await loadWarnings().catch(() => []);
  const items = warnings.slice(0, 50).map((item) => {
    const title = `${item.location || "Slovensko"} – hlásený výskyt medveďa`;
    const description = [
      `Lokalita: ${item.location || "neuvedená"}.`,
      `Čas hlásenia: ${formatSlovakDate(item.reportedAt, true)}.`,
      item.note ? String(item.note).slice(0, 400) : "",
      "Údaj je orientačný a nepotvrdzuje aktuálnu polohu zvieraťa.",
    ].filter(Boolean).join(" ");
    return `  <item>\n    <title>${escapeHtml(title)}</title>\n    <link>${escapeHtml(`${origin}/`)}</link>\n    <guid isPermaLink="false">${escapeHtml(item.id)}</guid>\n    <pubDate>${new Date(item.reportedAt || Date.now()).toUTCString()}</pubDate>\n    <description>${escapeHtml(description)}</description>\n  </item>`;
  }).join("\n");
  res
    .type("application/rss+xml")
    .set("Cache-Control", "public, max-age=300")
    .send(`<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n<channel>\n  <title>Kde je Medveď – aktuálne hlásenia</title>\n  <link>${escapeHtml(`${origin}/`)}</link>\n  <description>Najnovšie moderované hlásenia výskytu medveďov na Slovensku.</description>\n  <language>sk-SK</language>\n  <lastBuildDate>${new Date(latestContentDate() || Date.now()).toUTCString()}</lastBuildDate>\n${items}\n</channel>\n</rss>\n`);
});

// --- Basic Auth pre administráciu ---
function adminAuth(req, res, next) {
  // Pri /api volaniach vraciame JSON, nech frontend nespadne na res.json().
  const wantsJson = req.path.startsWith("/api");
  const fail = (status, msg) =>
    wantsJson ? res.status(status).json({ ok: false, error: msg }) : res.status(status).send(msg);

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return fail(500, "Chyba servera: ADMIN_PASSWORD nie je nastavené v .env súbore.");
  }

  const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

  if (login === 'admin' && password === adminPassword) {
    return next();
  }

  // WWW-Authenticate len pre prehliadačovú navigáciu (/admin), nie pre fetch.
  if (!wantsJson) res.set('WWW-Authenticate', 'Basic realm="Admin Sledovac"');
  return fail(401, 'Vyžaduje sa prihlásenie (meno: admin).');
}

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/api/admin/pending", adminAuth, async (_req, res) => {
  try {
    const [reports, sightings, news] = await Promise.all([
      loadBearReports("pending"),
      loadPendingSightings(),
      loadPendingNews(),
    ]);
    res.json({ ok: true, reports, sightings, news });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

function selectedAdminLocation(name, latValue, lngValue) {
  const lat = Number(latValue);
  const lng = Number(lngValue);
  if (!isSlovakCoordinate(lat, lng)) return null;
  return { name, lat, lng, type: "selected" };
}

async function resolveAdminLocation(name, latValue, lngValue) {
  const selected = selectedAdminLocation(name, latValue, lngValue);
  if (selected) return selected;

  const gz = await loadPlaces();
  const municipality = lookupPlaceByName(name, gz);
  if (municipality) return municipality;

  const results = await searchSlovakLocations(name);
  return results[0] || null;
}

// Explicitné vyhľadávanie pre admina. Na rozdiel od lokálneho gazetteeru nájde
// aj doliny, jazerá, vrchy a ďalšie pomenované body na mape.
app.get("/api/admin/locations", adminAuth, async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (query.length < 2 || query.length > 120) {
    return res.status(400).json({
      ok: false,
      error: "Zadajte aspoň 2 znaky názvu lokality.",
    });
  }

  try {
    const gz = await loadPlaces();
    const municipality = lookupPlaceByName(query, gz);
    let remote = [];
    try {
      remote = await searchSlovakLocations(query);
    } catch (err) {
      // Obce vieme nájsť aj offline. Externá chyba preto nemá znefunkčniť
      // výsledok z lokálneho gazetteeru.
      if (!municipality) throw err;
    }
    const results = municipality
      ? [
          {
            name: municipality.name,
            label: `${municipality.name}, Slovensko`,
            lat: municipality.lat,
            lng: municipality.lng,
            type: municipality.type,
            source: "gazetteer",
          },
          ...remote.filter(
            (item) =>
              item.name.toLocaleLowerCase("sk") !== municipality.name.toLocaleLowerCase("sk")
          ),
        ]
      : remote;
    res.set("Cache-Control", "private, max-age=1800");
    res.json({ ok: true, results: results.slice(0, 6) });
  } catch (err) {
    console.error("[admin locations] search failed:", err.message);
    res.status(502).json({
      ok: false,
      error: "Vyhľadávanie lokalít je dočasne nedostupné. Skúste to znova.",
    });
  }
});

app.post("/api/admin/reports/:id/status", adminAuth, async (req, res) => {
  const { status } = req.body || {};
  if (!["approved", "rejected"].includes(status)) {
    return res.status(400).json({ ok: false, error: "Neplatný stav." });
  }
  try {
    await updateBearReportStatus(Number(req.params.id), status);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Schválenie/zamietnutie scrapovaného hlásenia (tumedved.sk). Po zmene obnovíme
// pamäťovú kópiu, nech sa na mape hneď objaví (schválené) alebo zmizne.
app.post("/api/admin/sightings/:id/status", adminAuth, async (req, res) => {
  const { status } = req.body || {};
  if (!["approved", "rejected"].includes(status)) {
    return res.status(400).json({ ok: false, error: "Neplatný stav." });
  }
  try {
    await updateSightingStatus(req.params.id, status);
    await sightingsStore.loadFromDatabase().catch((err) => {
      console.error("[sighting status] reload failed:", err.message);
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/admin/news/:id/status", adminAuth, async (req, res) => {
  const { status } = req.body || {};
  if (!["approved", "rejected"].includes(status)) {
    return res.status(400).json({ ok: false, error: "Neplatný stav." });
  }
  try {
    await updateNewsStatus(req.params.id, status);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Schválenie správy s kategorizáciou (varovanie/článok) a úpravou lokality.
// Pri 'warning' prijmeme vybraný bod na mape alebo názov geokódujeme.
app.post("/api/admin/news/:id/review", adminAuth, async (req, res) => {
  const { status, category, place, lat, lng } = req.body || {};
  if (!["approved", "rejected"].includes(status)) {
    return res.status(400).json({ ok: false, error: "Neplatný stav." });
  }

  try {
    const fields = { status };

    if (status === "approved") {
      const cat = category === "warning" ? "warning" : "article";
      fields.category = cat;

      if (cat === "warning") {
        const name = typeof place === "string" ? place.trim() : "";
        if (!name) {
          return res
            .status(400)
            .json({ ok: false, error: "Pri medvedom varovaní zadajte lokalitu." });
        }
        const hit = await resolveAdminLocation(name, lat, lng);
        if (!hit) {
          return res.status(400).json({
            ok: false,
            error: `Lokalita „${name}“ sa na Slovensku nenašla. Skontrolujte názov alebo ju vyhľadajte a vyberte zo zoznamu.`,
          });
        }
        fields.place = hit.name;
        fields.lat = hit.lat;
        fields.lng = hit.lng;
      }
    }

    await reviewNews(req.params.id, fields);
    // Obnov pamäťovú kópiu, nech sa zmena hneď prejaví na webe aj na mape.
    await newsStore.loadFromDatabase().catch((err) => {
      console.error("[news review] reload failed:", err.message);
    });

    res.json({
      ok: true,
      category: fields.category || null,
      place: fields.place || null,
      lat: fields.lat ?? null,
      lng: fields.lng ?? null,
    });
  } catch (err) {
    console.error("[news review] failed:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Admin: správa obsahu (všetky správy + hlásenia, editácia) ---

app.get("/api/admin/content", adminAuth, async (_req, res) => {
  try {
    const [news, sightings] = await Promise.all([loadAllNews(), loadAllSightings()]);
    res.json({ ok: true, news, sightings });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/admin/news/:id/edit", adminAuth, async (req, res) => {
  try {
    await updateNewsFields(req.params.id, req.body || {});
    await newsStore.loadFromDatabase().catch((err) => {
      console.error("[news edit] reload failed:", err.message);
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("[news edit] failed:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/admin/sightings/:id/edit", adminAuth, async (req, res) => {
  try {
    await updateSightingFields(req.params.id, req.body || {});
    await sightingsStore.loadFromDatabase().catch((err) => {
      console.error("[sighting edit] reload failed:", err.message);
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("[sighting edit] failed:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Manuálne pridanie položky adminom. Typ určuje cieľovú tabuľku:
//   news         -> news_logs (bežný článok, len v zozname správ)
//   news-warning -> news_logs (medvedie varovanie zo správ, na mape)
//   tumedved     -> tumedved_logs (hlásenie so štítkom tumedved.sk)
//   warning      -> bear_reports so statusom approved (všeobecné varovanie)
app.post("/api/admin/warnings", adminAuth, async (req, res) => {
  const { type, title, location, description, source, link, place, lat, lng, date } = req.body || {};

  if (!["news", "news-warning", "tumedved", "warning"].includes(type)) {
    return res.status(400).json({ ok: false, error: "Neplatný typ položky." });
  }

  const reportedAt = date ? new Date(date) : new Date();
  if (Number.isNaN(reportedAt.getTime())) {
    return res.status(400).json({ ok: false, error: "Neplatný dátum." });
  }

  try {
    let geo = null;
    const placeName = typeof place === "string" ? place.trim() : "";
    if (placeName) {
      geo = await resolveAdminLocation(placeName, lat, lng);
      if (!geo) {
        return res.status(400).json({
          ok: false,
          error: `Lokalita „${placeName}” sa na Slovensku nenašla. Skontrolujte názov alebo ju vyhľadajte a vyberte zo zoznamu.`,
        });
      }
    }

    if (type === "news" || type === "news-warning") {
      const cleanTitle = typeof title === "string" ? title.trim() : "";
      if (!cleanTitle) {
        return res.status(400).json({ ok: false, error: "Titulok je povinný." });
      }
      if (type === "news-warning" && !geo) {
        return res
          .status(400)
          .json({ ok: false, error: "Pri medvedom varovaní zo správ zadajte lokalitu." });
      }

      await saveManualNews({
        id: `manual-news-${Date.now()}`,
        source: source?.trim() || "Manuálne pridané",
        title: cleanTitle,
        link: link?.trim() || null,
        snippet: description?.trim() || null,
        publishedAt: reportedAt.toISOString(),
        category: type === "news-warning" ? "warning" : "article",
        place: type === "news-warning" ? geo.name : null,
        lat: type === "news-warning" ? geo.lat : null,
        lng: type === "news-warning" ? geo.lng : null,
      });

      await newsStore.loadFromDatabase().catch((err) => {
        console.error("[manual news] reload failed:", err.message);
      });
    } else {
      const loc = (typeof location === "string" && location.trim()) || geo?.name || "";
      if (!loc) {
        return res.status(400).json({ ok: false, error: "Lokalita je povinná." });
      }

      if (type === "tumedved") {
        await saveManualTumedved({
          id: `manual-tm-${Date.now()}`,
          location: loc,
          note: description?.trim() || null,
          lat: geo?.lat ?? null,
          lng: geo?.lng ?? null,
          reportedAt: reportedAt.toISOString(),
          url: link?.trim() || null,
        });

        await sightingsStore.loadFromDatabase().catch((err) => {
          console.error("[manual tumedved] reload failed:", err.message);
        });
      } else {
        await saveBearReport({
          location: loc,
          description: description?.trim() || null,
          lat: geo?.lat ?? null,
          lng: geo?.lng ?? null,
          reportedDate: reportedAt.toISOString(),
          status: "approved",
        });
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("[manual warning] save failed:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/admin/subscriptions", adminAuth, async (_req, res) => {
  try {
    const subs = await loadEmailSubscriptions();
    res.json({ ok: true, subscriptions: subs });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/admin/subscriptions/:id", adminAuth, async (req, res) => {
  try {
    await deleteEmailSubscription(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/admin/refresh", adminAuth, async (_req, res) => {
  const result = await refreshAll("admin");
  const failed = result.errors ? Object.keys(result.errors) : [];

  let message;
  if (!result.ok) message = "Sťahovanie zlyhalo.";
  else if (failed.length) message = `Čiastočne dokončené — zlyhalo: ${failed.join(", ")}.`;
  else message = "Sťahovanie úspešne dokončené.";

  res.status(result.ok ? 200 : 502).json({ ...result, message });
});

// Servíruje @vercel/analytics ako ES modul priamo z node_modules, nech ho
// vieme importovať v prehliadači bez bundlera (public/ je čistý HTML/JS).
app.use(
  "/vendor/analytics",
  express.static(path.join(__dirname, "node_modules", "@vercel", "analytics", "dist"), {
    setHeaders(res) {
      res.setHeader("Cache-Control", "public, max-age=3600");
    },
  })
);

app.use(
  express.static(path.join(__dirname, "public"), {
    etag: true,
    lastModified: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith(".html")) {
        // HTML vždy prevaliduj, nech sa nasadené zmeny prejavia okamžite.
        res.setHeader("Cache-Control", "no-cache");
      } else if (/\.(png|jpe?g|webp|gif|svg|ico|woff2?)$/i.test(filePath)) {
        // Obrázky a fonty sa menia zriedka — drž ich v cache 30 dní.
        res.setHeader("Cache-Control", "public, max-age=2592000");
      } else if (/\.(css|js)$/i.test(filePath)) {
        // CSS/JS bez hashu v názve — kratšia cache + revalidácia cez ETag.
        res.setHeader("Cache-Control", "public, max-age=3600");
      }
    },
  })
);

app.listen(PORT, () => {
  console.log(`\n🐻 Medveď Sledovač beží na http://localhost:${PORT}\n`);
  console.log(
    `Supabase: ${isSupabaseConfigured() ? "configured" : "not configured"}; refresh: external cron`
  );
  sightingsStore.start().catch((err) => {
    console.error("[tumedved] startup load failed:", err.message);
  });
  newsStore.start().catch((err) => {
    console.error("[news] startup load failed:", err.message);
  });

  if (isSupabaseConfigured()) {
    Promise.all([
      sightingsStore.refresh("startup"),
      newsStore.refresh("startup"),
    ]).catch((err) => {
      console.error("[startup] refresh failed:", err.message);
    });
  }
});
