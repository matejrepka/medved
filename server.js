// Medveď Sledovač — server.
//
// Dáta sa sťahujú výhradne cez externý cron job (cron-job.org), ktorý volá
// /api/cron/refresh. Server pri štarte načíta existujúce dáta
// zo Supabase a servíruje ich cez JSON API + frontend zo zložky /public.

import "dotenv/config";
import express from "express";
import compression from "compression";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

import { fetchSightings } from "./src/scrapers/sightings.js";
import { fetchNews } from "./src/scrapers/news.js";
import { ScheduledDataStore } from "./src/scheduled-store.js";
import { sightingSourceLinks } from "./src/sightings-dedupe.js";
import { mergeWarnings } from "./src/warnings.js";
import {
  correctionMailto,
  newsRecordKind,
  recordFreshness,
  warningRecordKind,
} from "./src/record-presentation.js";
import { classifyFreshNews } from "./src/ai/news-classifier.js";
import {
  classifyReportSpam,
} from "./src/ai/report-spam-classifier.js";
import { loadPlaces, lookupPlaceByName } from "./src/geo/geocode.js";
import { isSlovakCoordinate, searchSlovakLocations } from "./src/geo/search.js";
import { buildStatsReport } from "./src/stats-report.js";
import { normalizeNewsLocations } from "./src/news-locations.js";
import { mergeLocationPages } from "./src/location-pages.js";
import { isSupabaseConfigured } from "./src/db/supabase.js";
import { readTelegramConfig } from "./src/telegram/config.js";
import { TelegramService, webhookSecretMatches } from "./src/telegram/service.js";
import { readEmailConfig } from "./src/email/config.js";
import { EmailService } from "./src/email/service.js";
import { verifyEmailToken } from "./src/email/tokens.js";
import {
  confirmEmailSubscription,
  deleteEmailSubscription,
  hashIp,
  loadAllBearReports,
  loadAllNews,
  loadAllSightings,
  loadApprovedBearReports,
  loadBearReports,
  loadEmailSubscriptions,
  loadIncidentSuggestions,
  loadNewsLogs,
  loadPendingNews,
  loadTumedvedLogs,
  markEmailConfirmationSent,
  recordScrapeRun,
  saveBearReport,
  saveEmailSubscription,
  saveManualNews,
  saveManualTumedved,
  saveNewsLogs,
  saveTumedvedLogs,
  saveWebsiteLog,
  updateBearReportStatus,
  updateBearReportFields,
  updateNewsFields,
  updateSightingFields,
  updateSightingStatus,
  unsubscribeEmailSubscription,
  reviewNewsWithAutomaticIncident,
} from "./src/db/repository.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = process.env.PORT || 3000;
const CRON_REFRESH_SECRET = process.env.CRON_REFRESH_SECRET;
const INDEXNOW_KEY = process.env.INDEXNOW_KEY || "03a59456ce8341fba7b18cf916aa32e8";
const CANONICAL_SITE_ORIGIN = "https://www.kdejemedved.sk";
const CONTENT_UPDATED = "2026-07-14T00:00:00+02:00";
const LOCATION_ROUTE_PREFIX = "/vyskyt-medveda/";
const NEWS_ROUTE_PREFIX = "/spravy/";
const WARNING_ROUTE_PREFIX = "/varovania/";
const ARCHIVE_PAGE_SIZE = 24;
const ARCHIVE_PAGE_SIZES = new Set([24, 50, 100]);
const DISABLE_STARTUP_REFRESH = process.env.DISABLE_STARTUP_REFRESH === "true";
const DISABLE_WEBSITE_LOGS = process.env.DISABLE_WEBSITE_LOGS === "true";
const parsedTelegramConfig = readTelegramConfig();
const telegramConfig = {
  ...parsedTelegramConfig,
  enabled: parsedTelegramConfig.enabled && isSupabaseConfigured(),
};
const parsedEmailConfig = readEmailConfig();
const emailConfig = {
  ...parsedEmailConfig,
  enabled: parsedEmailConfig.enabled && isSupabaseConfigured(),
};

const PUBLIC_PAGES = {
  "/": {
    file: "index.html",
    title: "Mapa medveďov na Slovensku | Aktuálne varovania",
    description:
      "Aktuálna mapa medveďov na Slovensku spája hlásený výskyt, verejné varovania a správy s lokalitou, dátumom a pôvodným zdrojom.",
    schemaType: "CollectionPage",
    dynamicLastmod: true,
    priority: "1.0",
  },
  "/domov": {
    file: "domov.html",
    title: "Medvede na Slovensku | Mapa hlásení Kde je Medveď",
    description:
      "Prehľad medveďov na Slovensku: mapa hlásení, verejné varovania, lokality a aktuálne správy s uvedením zdroja a dátumu.",
    schemaType: "WebPage",
    dynamicLastmod: true,
    changefreq: "daily",
    priority: "0.9",
  },
  "/stats": {
    file: "stats.html",
    title: "Štatistiky výskytu medveďov na Slovensku | Kde je Medveď",
    description:
      "Aktuálne štatistiky hlásení výskytu medveďov na Slovensku: vývoj v čase, najčastejšie lokality a čas hlásení.",
    schemaType: "CollectionPage",
    dynamicLastmod: true,
    changefreq: "daily",
    priority: "0.8",
  },
  "/spravy": {
    file: "spravy.html",
    title: "Správy o medveďoch na Slovensku | Kde je Medveď",
    description:
      "Najnovšie správy o medveďoch na Slovensku s krátkym vecným súhrnom, dátumom a odkazom na pôvodný zdroj.",
    schemaType: "CollectionPage",
    dynamicLastmod: true,
    changefreq: "daily",
    priority: "0.9",
  },
  "/varovania": {
    file: "varovania.html",
    title: "Aktuálne varovania pred medveďmi na Slovensku",
    description:
      "Prehľad verejných varovaní a hláseného výskytu medveďov na Slovensku podľa lokality, dátumu a pôvodného zdroja.",
    schemaType: "CollectionPage",
    dynamicLastmod: true,
    changefreq: "daily",
    priority: "0.9",
  },
  "/nahlas": {
    file: "nahlas.html",
    title: "Nahlásiť výskyt medveďa na Slovensku | Kde je Medveď",
    description:
      "Nahláste pozorovanie medveďa na Slovensku, označte miesto na mape a doplňte čas a okolnosti. Hlásenie pred zverejnením skontrolujeme.",
    schemaType: "WebPage",
    lastmod: CONTENT_UPDATED,
    changefreq: "monthly",
    priority: "0.7",
  },
  "/bezpecnost": {
    file: "bezpecnost.html",
    title: "Čo robiť pri stretnutí s medveďom | Oficiálne odporúčania",
    description:
      "Stručný postup pri stretnutí alebo útoku medveďa podľa odporúčaní Zásahového tímu ŠOP SR. Prevencia, tiesňová linka 112 a dôležité kontakty.",
    schemaType: "Article",
    lastmod: CONTENT_UPDATED,
    changefreq: "monthly",
    priority: "0.9",
  },
  "/o-mape": {
    file: "o-mape.html",
    title: "O projekte Kde je Medveď | Mapa výskytu medveďov",
    description:
      "Prečo vznikol projekt Kde je Medveď, ako pomáha získať prehľad o výskyte medveďov, z akých zdrojov čerpá a ako nás kontaktovať.",
    schemaType: "AboutPage",
    lastmod: CONTENT_UPDATED,
    changefreq: "monthly",
    priority: "0.7",
  },
  "/spomenuli-nas": {
    file: "spomenuli-nas.html",
    title: "Spomenuli nás | Kde je Medveď v médiách",
    description:
      "Prečítajte si, kde médiá spomenuli projekt Kde je Medveď a jeho mapu hláseného výskytu medveďov na Slovensku.",
    schemaType: "CollectionPage",
    lastmod: "2026-07-17T00:00:00+02:00",
    changefreq: "monthly",
    priority: "0.5",
  },
  "/privacy": {
    file: "privacy.html",
    title: "Ochrana súkromia | Kde je Medveď",
    description:
      "Ako služba Kde je Medveď spracúva kontaktné, technické a analytické údaje, používa cookies a chráni súkromie návštevníkov a oznamovateľov.",
    schemaType: "WebPage",
    lastmod: "2026-07-31T00:00:00+02:00",
    changefreq: "yearly",
    priority: "0.2",
  },
  "/terms": {
    file: "terms.html",
    title: "Podmienky používania | Kde je Medveď",
    description:
      "Pravidlá používania služby Kde je Medveď, externých zdrojov, používateľských hlásení, e-mailových upozornení a orientačných údajov mapy.",
    schemaType: "WebPage",
    lastmod: "2026-07-31T00:00:00+02:00",
    changefreq: "yearly",
    priority: "0.2",
  },
};

const pageTemplateCache = new Map();

function siteOrigin() {
  // Verejné SEO URL nesmú závisieť od preview hostu ani Host hlavičky požiadavky.
  return CANONICAL_SITE_ORIGIN;
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

function normalizeSearchText(value) {
  return String(value || "")
    .toLocaleLowerCase("sk")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replaceAll("ľ", "l")
    .replaceAll("ĺ", "l")
    .replaceAll("ŕ", "r")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function locationSlug(value) {
  return normalizeSearchText(value).replaceAll(" ", "-");
}

function locationPath(value) {
  return `${LOCATION_ROUTE_PREFIX}${encodeURIComponent(locationSlug(value))}`;
}

function recordToken(id) {
  return createHash("sha256").update(String(id || "record")).digest("hex").slice(0, 10);
}

function recordSlug(value, fallback = "zaznam") {
  return locationSlug(value).slice(0, 72) || fallback;
}

function newsPath(item) {
  const prefix = item?.category === "warning" ? WARNING_ROUTE_PREFIX : NEWS_ROUTE_PREFIX;
  return `${prefix}${recordSlug(item?.title, "sprava-o-medvedovi")}-${recordToken(item?.id)}`;
}

function warningPath(item) {
  return `${WARNING_ROUTE_PREFIX}${recordSlug(item?.location || item?.title, "varovanie-pred-medvedom")}-${recordToken(item?.id)}`;
}

function detailPath(item, type) {
  return type === "warning" ? warningPath(item) : newsPath(item);
}

async function notifyIndexNow(paths) {
  const submissionOrigin = CANONICAL_SITE_ORIGIN;
  if (!submissionOrigin || !INDEXNOW_KEY) {
    return { ok: false, skipped: true, reason: "Verejná URL alebo INDEXNOW_KEY nie je nastavený" };
  }

  const originUrl = new URL(submissionOrigin);
  const urlList = [...new Set(paths.map((pathname) => absoluteUrl(originUrl.origin, pathname)))];
  try {
    const response = await fetch("https://api.indexnow.org/indexnow", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        host: originUrl.host,
        key: INDEXNOW_KEY,
        keyLocation: absoluteUrl(originUrl.origin, `/${INDEXNOW_KEY}.txt`),
        urlList,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`IndexNow vrátil HTTP ${response.status}`);
    return { ok: true, submitted: urlList.length };
  } catch (err) {
    console.error("[indexnow] submission failed:", err.message);
    return { ok: false, error: err.message };
  }
}

function latestContentDate() {
  return [sightingsStore.meta.fetchedAt, newsStore.meta.fetchedAt]
    .filter(Boolean)
    .sort()
    .pop() || null;
}

function faqEntities(origin) {
  return [
    {
      question: "Kde je medveď na Slovensku?",
      answer:
        "Najnovšie hlásené pozorovania a verejné varovania nájdete na aktuálnej mape Kde je Medveď. Každý bod uvádza lokalitu, čas a dostupný pôvod informácie; nejde však o živé GPS sledovanie zvieraťa.",
    },
    {
      question: "Čo je Kde je Medveď?",
      answer:
        "Kde je Medveď je nezávislý slovenský agregátor. Na jednom mieste spája moderované hlásenia, verejné mapy a varovania, relevantné správy, štatistiky a bezpečnostné odporúčania.",
    },
    {
      question: "Z akých zdrojov pochádzajú informácie o medveďoch?",
      answer:
        "Prehľad spája používateľské hlásenia, verejne dostupné záznamy zo slovenských máp výskytu, upozornenia ŠOP SR a relevantné slovenské správy. Pri každej položke zachováva názov a odkaz na pôvodný zdroj.",
    },
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
      answer: "Bezpečnosť: Zásahový tím pre medveďa hnedého ŠOP SR",
      answerUrl: "https://zasahovytim.sopsr.sk/bezpecnost/",
    },
    {
      question: "Ako môžem kontaktovať prevádzkovateľa?",
      answer:
        "Otázky, pripomienky a žiadosti o opravu môžete poslať na kontakt@kdejemedved.sk.",
      answerUrl: absoluteUrl(origin, "/o-mape#kontakt"),
    },
  ];
}

function structuredDataForPage(pathname, page, origin) {
  const canonical = absoluteUrl(origin, pathname);
  const websiteId = `${origin}/#website`;
  const organizationId = `${origin}/#organization`;
  const modified = page.dateModified || (
    page.dynamicLastmod
      ? latestContentDate() || CONTENT_UPDATED
      : page.lastmod || CONTENT_UPDATED
  );
  const bearEntity = {
    "@type": "Thing",
    name: "Medveď hnedý",
    alternateName: "Ursus arctos",
    sameAs: "https://www.wikidata.org/wiki/Q36341",
  };
  const graph = [
    {
      "@type": "Organization",
      "@id": organizationId,
      name: "Kde je Medveď",
      url: `${origin}/`,
      description:
        "Nezávislý slovenský agregátor hlásení, verejných varovaní a správ o výskyte medveďov.",
      areaServed: { "@type": "Country", name: "Slovensko" },
      knowsAbout: [bearEntity, "Výskyt medveďov na Slovensku", "Medvedie varovania"],
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
      alternateName: [
        "Kde je medved",
        "Mapa medveďov Slovensko",
        "Mapa medvedov na Slovensku",
        "Mapa výskytu medveďov",
        "Medvede na Slovensku",
      ],
      url: `${origin}/`,
      inLanguage: "sk-SK",
      about: bearEntity,
      keywords: [
        "kde je medveď",
        "mapa medveďov na Slovensku",
        "mapa medvedov na Slovensku",
        "medvede na Slovensku",
        "výskyt medveďa",
        "medvedie varovania",
      ],
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
      about: page.location
        ? [{ "@type": "Place", name: page.location.name }, bearEntity]
        : bearEntity,
      dateModified: modified,
    },
  ];

  if (pathname !== "/") {
    graph.push({
      "@type": "BreadcrumbList",
      "@id": `${canonical}#breadcrumb`,
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Mapa", item: `${origin}/` },
        {
          "@type": "ListItem",
          position: 2,
          name: page.breadcrumbName || page.title.split("|")[0].trim(),
          item: canonical,
        },
      ],
    });
  }

  if (pathname === "/") {
    graph.push(
      {
        "@type": "WebApplication",
        "@id": `${origin}/#application`,
        name: "Kde je Medveď: mapa výskytu medveďov",
        url: `${origin}/`,
        applicationCategory: "TravelApplication",
        applicationSubCategory: "Mapa výskytu medveďov a verejných varovaní",
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
          "Priebežne aktualizovaný súbor hlásení a verejných varovaní z viacerých slovenských zdrojov s dátumom, lokalitou, pôvodom informácie a dostupnými súradnicami.",
        url: `${origin}/`,
        distribution: {
          "@type": "DataDownload",
          encodingFormat: "application/json",
          contentUrl: absoluteUrl(origin, "/api/warnings"),
        },
        spatialCoverage: { "@type": "Place", name: "Slovensko" },
        about: bearEntity,
        keywords: [
          "výskyt medveďa",
          "mapa medveďov",
          "medvedie varovania",
          "Slovensko",
        ],
        variableMeasured: [
          "lokalita hlásenia",
          "dátum a čas hlásenia",
          "zdroj informácie",
          "súradnice, ak sú dostupné",
        ],
        measurementTechnique:
          "Agregácia verejných zdrojov a používateľských hlásení, zjednotenie údajov, odstránenie duplicít a moderovanie pred zverejnením.",
        citation: [
          "https://tumedved.sk/",
          "https://mapamedvedov.sk/",
          "https://www.sprejnamedveda.sk/medvede-na-mape/",
          "https://www.pozormedved.sk/",
          "https://zasahovytim.sopsr.sk/",
        ],
        creator: { "@id": organizationId },
        inLanguage: "sk-SK",
        isAccessibleForFree: true,
        dateModified: modified,
        license: absoluteUrl(origin, "/terms"),
      }
    );
  }

  // FAQ schema patrí iba na stránku, kde návštevník vidí rovnaké otázky a odpovede.
  if (pathname === "/domov") {
    graph.push({
      "@type": "FAQPage",
      "@id": `${canonical}#faq`,
      mainEntity: faqEntities(origin).map(({ question, answer, answerUrl }) => ({
        "@type": "Question",
        name: question,
        acceptedAnswer: {
          "@type": "Answer",
          text: answer,
          ...(answerUrl ? { url: answerUrl } : {}),
        },
      })),
    });
  }

  if (page.location) {
    const datasetId = `${canonical}#dataset`;
    const webpage = graph.find((item) => item["@id"] === `${canonical}#webpage`);
    webpage.mainEntity = { "@id": datasetId };
    graph.push({
      "@type": "Dataset",
      "@id": datasetId,
      name: `Hlásený výskyt medveďa: ${page.location.name}`,
      description: page.description,
      url: canonical,
      about: [
        bearEntity,
        { "@type": "Place", name: page.location.name },
      ],
      spatialCoverage: { "@type": "Place", name: page.location.name },
      ...(page.location.first && page.location.latest
        ? { temporalCoverage: `${page.location.first}/${page.location.latest}` }
        : {}),
      variableMeasured: ["hlásenia výskytu", "verejné varovania", "súvisiace správy"],
      creator: { "@id": organizationId },
      inLanguage: "sk-SK",
      isAccessibleForFree: true,
      dateModified: modified,
      license: absoluteUrl(origin, "/terms"),
    });
  }

  if (page.record) {
    const record = page.record;
    const article = graph.find((item) => item["@id"] === `${canonical}#webpage`);
    const sourceUrl = safeHttpUrl(
      record.articleUrl || record.link || record.googleNewsUrl || record.url || ""
    );
    Object.assign(article, {
      headline: record.title || record.location || page.title.split("|")[0].trim(),
      author: { "@id": organizationId },
      publisher: { "@id": organizationId },
      datePublished: record.date || record.reportedAt || modified,
      dateModified: record._scrapedAt || record.date || record.reportedAt || modified,
      ...(record.summary || record.snippet || record.note
        ? { abstract: record.summary || record.snippet || record.note }
        : {}),
      ...(sourceUrl ? { citation: [sourceUrl], isBasedOn: sourceUrl } : {}),
      mainEntityOfPage: { "@id": `${canonical}#webpage` },
    });
  }

  if (pathname === "/o-mape") {
    const aboutPage = graph.find((item) => item["@id"] === `${canonical}#webpage`);
    aboutPage.citation = [
      "https://tumedved.sk/",
      "https://mapamedvedov.sk/",
      "https://www.sprejnamedveda.sk/medvede-na-mape/",
      "https://www.pozormedved.sk/",
      "https://zasahovytim.sopsr.sk/",
    ];
  }

  if (pathname === "/spomenuli-nas") {
    const pressPage = graph.find((item) => item["@id"] === `${canonical}#webpage`);
    pressPage.citation = ["https://www.ahoj.tv/clanky/clanok/15931/"];
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
  const ogType = /Article$/.test(page.schemaType) ? "article" : "website";
  const schema = JSON.stringify(structuredDataForPage(pathname, page, origin)).replaceAll("<", "\\u003c");
  return [
    `<meta name="robots" content="${escapeHtml(page.robots || "index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1")}" />`,
    `<link rel="canonical" href="${escapeHtml(canonical)}" />`,
    '<meta property="og:locale" content="sk_SK" />',
    `<meta property="og:type" content="${ogType}" />`,
    '<meta property="og:site_name" content="Kde je Medveď" />',
    `<meta property="og:title" content="${escapeHtml(page.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(page.description)}" />`,
    `<meta property="og:url" content="${escapeHtml(canonical)}" />`,
    `<meta property="og:image" content="${escapeHtml(image)}" />`,
    `<meta property="og:image:secure_url" content="${escapeHtml(image)}" />`,
    '<meta property="og:image:type" content="image/png" />',
    '<meta property="og:image:width" content="700" />',
    '<meta property="og:image:height" content="700" />',
    '<meta property="og:image:alt" content="Ilustrácia medveďa pri mape Slovenska" />',
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:title" content="${escapeHtml(page.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(page.description)}" />`,
    `<meta name="twitter:image" content="${escapeHtml(image)}" />`,
    '<meta name="twitter:image:alt" content="Ilustrácia medveďa pri mape Slovenska" />',
    '<meta name="theme-color" content="#1f4b30" />',
    '<link rel="manifest" href="/manifest.webmanifest" />',
    '<link rel="alternate" type="application/rss+xml" title="Aktuálne hlásenia: Kde je Medveď" href="/feed.xml" />',
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

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function renderListingSourceMeta(label, links = []) {
  const sourceLabel = String(label || "").trim();
  if (!sourceLabel) return "";
  const safeLinks = links
    .map((link) => ({ label: String(link?.label || "").trim(), url: safeHttpUrl(link?.url) }))
    .filter((link) => link.label && link.url);
  const mobileLinks = safeLinks.length
    ? `<span class="meta-source-links-mobile">${safeLinks.map((link) =>
        `<a class="meta-source-link" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)} <span aria-hidden="true">↗</span></a>`
      ).join("")}</span>`
    : "";
  return `<span class="meta-source${safeLinks.length ? " has-mobile-source-links" : ""}"><span class="meta-label">Zdroj:</span><span class="meta-source-text">${escapeHtml(sourceLabel)}</span>${mobileLinks}</span>`;
}

function renderSsrWarnings(items, emptyMessage = "Hlásenia sa načítavajú…", limit = 15) {
  if (!items.length) return `<p class="empty">${escapeHtml(emptyMessage)}</p>`;
  return items.slice(0, limit).map((item) => {
    const sourceLinks = sightingSourceLinks(item)
      .map((entry) => ({ ...entry, url: safeHttpUrl(entry.url) }))
      .filter((entry) => entry.url);
    const source = sourceLinks.length
      ? [...new Set(sourceLinks.map((entry) => entry.label))].join(" · ")
      : item.sourceType === "report"
        ? "moderované hlásenie"
        : item.source || "verejný zdroj";
    const note = item.note ? `<p class="card-note">${escapeHtml(String(item.note).slice(0, 240))}</p>` : "";
    const kind = warningRecordKind(item);
    const freshness = recordFreshness(item.reportedAt);
    const detail = warningPath(item);
    const withTime = item.datePrecision !== "date";
    const correction = correctionMailto(item, kind.label.toLocaleLowerCase("sk-SK"));
    const links = sourceLinks.length
      ? `<div class="source-links">${sourceLinks.map((entry) =>
          `<a class="card-link" href="${escapeHtml(entry.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry.label)} <span aria-hidden="true">→</span></a>`
        ).join("")}</div>`
      : "";
    return `<article class="card sighting ssr-list-item" data-id="${escapeHtml(item.id)}">
      <div class="record-signals"><span class="record-kind kind-${escapeHtml(kind.key)}">${escapeHtml(kind.label)}</span><span class="record-freshness freshness-${escapeHtml(freshness.key)}"><span class="sr-only">Aktuálnosť: </span>${escapeHtml(freshness.label)}</span></div>
      <h4 class="card-title"><a class="card-title-link" href="${escapeHtml(detail)}">${escapeHtml(item.location || "Lokalita neuvedená")}</a></h4>
      <div class="card-meta">${renderListingSourceMeta(source, sourceLinks)}<time datetime="${escapeHtml(item.reportedAt || "")}"><span class="meta-label">${withTime ? "Hlásené:" : "Dátum:"}</span>${escapeHtml(formatSlovakDate(item.reportedAt, withTime))}</time></div>
      ${note}<div class="card-actions"><div class="card-primary-actions"><a class="card-detail-action" href="${escapeHtml(detail)}"><i class="ph ph-article" aria-hidden="true"></i>Detail záznamu</a></div><a class="card-correction" href="${escapeHtml(correction)}" aria-label="Nahlásiť chybu v zázname ${escapeHtml(item.location || "Lokalita neuvedená")}">Nahlásiť chybu</a>${links ? `<div class="card-source-row mobile-source-duplicate"><span class="card-source-label">Overiť v zdroji</span>${links}</div>` : ""}</div>
    </article>`;
  }).join("\n");
}

function renderSsrNewsLocations(item) {
  const locations = normalizeNewsLocations(
    item.locations?.length
      ? item.locations
      : { place: item.place, lat: item.lat, lng: item.lng }
  );
  if (!locations.length || (item.category !== "warning" && !item.isIncident)) return "";

  return `<div class="news-location-links" aria-label="Lokality varovania">
    <span class="news-location-label"><i class="ph ph-map-pin" aria-hidden="true"></i> Lokality</span>
    ${locations.map((location, index) => location.hasCoords
      ? `<a href="#mapViewport" data-news-marker="${escapeHtml(`${item.id}:location:${index}`)}" data-lat="${escapeHtml(location.lat)}" data-lng="${escapeHtml(location.lng)}" aria-label="Zobraziť lokalitu ${escapeHtml(location.place)} na mape">${escapeHtml(location.place)}</a>`
      : `<span class="news-location-name">${escapeHtml(location.place)}</span>`
    ).join("")}
  </div>`;
}

function renderSsrNews(items, emptyMessage = "Správy sa načítavajú…", limit = 12) {
  if (!items.length) return `<p class="empty">${escapeHtml(emptyMessage)}</p>`;
  return items.slice(0, limit).map((item) => {
    const href = safeHttpUrl(item.articleUrl || item.link || item.googleNewsUrl || "");
    const link = href
      ? `<a class="card-link card-source-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">Otvoriť pôvodný článok <i class="ph ph-arrow-up-right" aria-hidden="true"></i></a>`
      : "";
    const kind = newsRecordKind(item);
    const freshness = recordFreshness(item.date);
    const detail = newsPath(item);
    const correction = correctionMailto(item, kind.label.toLocaleLowerCase("sk-SK"));
    const coverage = item.isIncident && Array.isArray(item.coverage) && item.coverage.length > 1
      ? `<details class="coverage-details" id="coverage-${escapeHtml(item.incidentId)}">
          <summary>Všetky zdroje (${item.coverage.length})</summary>
          <ul class="coverage-list">${item.coverage.map((article) => {
            const articleUrl = safeHttpUrl(article.url);
            return `<li><div><strong>${escapeHtml(article.source || "Verejný zdroj")}</strong><span>${escapeHtml(article.sourceTypeLabel || "Iný zdroj")}${article.publishedAt ? `, ${escapeHtml(formatSlovakDate(article.publishedAt, true))}` : ""}</span></div>${articleUrl ? `<a href="${escapeHtml(articleUrl)}" target="_blank" rel="noopener noreferrer">Otvoriť článok <span aria-hidden="true">→</span></a>` : ""}</li>`;
          }).join("")}</ul>
        </details>`
      : "";
    const sourceCount = item.sourceCount > 1
      ? `<span class="meta-coverage">${escapeHtml(slovakCount(item.sourceCount, "zdroj", "zdroje", "zdrojov"))}</span>`
      : "";
    const official = item.verificationStatus === "official_notice"
      ? '<span class="meta-official">Obsahuje úradné oznámenie</span>'
      : "";
    const locations = renderSsrNewsLocations(item);
    return `<article class="card news ssr-list-item" data-id="${escapeHtml(item.id)}"${item.incidentId ? ` id="incident-${escapeHtml(item.incidentId)}"` : ""}>
      <div class="record-signals"><span class="record-kind kind-${escapeHtml(kind.key)}">${escapeHtml(kind.label)}</span><span class="record-freshness freshness-${escapeHtml(freshness.key)}"><span class="sr-only">Aktuálnosť: </span>${escapeHtml(freshness.label)}</span></div>
      <h4 class="card-title"><a class="card-title-link" href="${escapeHtml(detail)}">${escapeHtml(item.title || "Správa o medveďovi")}</a></h4>
      <div class="card-meta">${renderListingSourceMeta(item.source || "verejný zdroj", href ? [{ label: item.source || "Zdroj", url: href }] : [])}${item.sourceTypeLabel ? `<span>${escapeHtml(item.sourceTypeLabel)}</span>` : ""}${sourceCount}${official}<time datetime="${escapeHtml(item.date || "")}"><span class="meta-label">Publikované:</span>${escapeHtml(formatSlovakDate(item.date))}</time></div>
      ${item.summary || item.snippet ? `<p class="card-note">${escapeHtml(String(item.summary || item.snippet).slice(0, 320))}</p>` : ""}
      ${locations}<div class="news-card-cta"><a class="card-detail-action news-card-detail-action" href="${escapeHtml(detail)}"><span>Pozrieť súhrn a podrobnosti</span><i class="ph ph-arrow-right" aria-hidden="true"></i></a></div><div class="card-actions card-actions-news">${link ? `<div class="card-source-row mobile-source-duplicate"><span class="card-source-label">Zdroj</span>${link}</div>` : ""}<a class="card-correction" href="${escapeHtml(correction)}" aria-label="Nahlásiť chybu v správe ${escapeHtml(item.title || "Správa o medveďovi")}">Nahlásiť chybu</a></div>${coverage}
    </article>`;
  }).join("\n");
}

function warningArchiveItems(overview) {
  const sightings = (overview?.warnings || []).map((item) => ({
    ...item,
    archiveType: "warning",
  }));
  const mediaWarnings = (overview?.news || [])
    .filter((item) => item.category === "warning")
    .map((item) => ({ ...item, archiveType: "news" }));
  return sightings.concat(mediaWarnings).sort((a, b) =>
    new Date(b.reportedAt || b.date || 0) - new Date(a.reportedAt || a.date || 0)
  );
}

function archiveSearchText(item) {
  return normalizeSearchText([
    item.title,
    item.location,
    item.place,
    item.source,
    item.summary,
    item.snippet,
    item.note,
    ...(Array.isArray(item.locations) ? item.locations.map((location) => location.place) : []),
  ].filter(Boolean).join(" "));
}

function archiveQueryUrl(pathname, { page = 1, pageSize = ARCHIVE_PAGE_SIZE, query = "" } = {}) {
  const params = new URLSearchParams();
  if (page > 1) params.set("strana", String(page));
  if (pageSize !== ARCHIVE_PAGE_SIZE) params.set("pocet", String(pageSize));
  if (query) params.set("q", query);
  const suffix = params.toString();
  return suffix ? `${pathname}?${suffix}#zoznam` : `${pathname}#zoznam`;
}

function renderArchiveFilters(pathname, { pageSize, query }) {
  return `<form class="archive-toolbar" action="${escapeHtml(pathname)}" method="get" role="search">
    <label class="archive-search"><span>Hľadať v záznamoch</span><span class="archive-search-field"><i class="ph ph-magnifying-glass" aria-hidden="true"></i><input type="search" name="q" value="${escapeHtml(query)}" placeholder="Lokalita, názov alebo zdroj" /></span></label>
    <label class="archive-page-size"><span>Počet na stránku</span><select name="pocet">${[24, 50, 100].map((size) => `<option value="${size}"${size === pageSize ? " selected" : ""}>${size}</option>`).join("")}</select></label>
    <button class="btn archive-submit" type="submit">Použiť filtre</button>
    ${query || pageSize !== ARCHIVE_PAGE_SIZE ? `<a class="archive-reset" href="${escapeHtml(pathname)}">Zrušiť filtre</a>` : ""}
  </form>`;
}

function renderArchivePagination(pathname, state) {
  if (state.totalPages <= 1) return "";
  const windowStart = Math.max(1, Math.min(state.page - 2, state.totalPages - 4));
  const windowEnd = Math.min(state.totalPages, windowStart + 4);
  const links = [];
  if (state.page > 1) {
    links.push(`<a class="pagination-direction" href="${escapeHtml(archiveQueryUrl(pathname, { ...state, page: state.page - 1 }))}"><i class="ph ph-arrow-left" aria-hidden="true"></i> Predchádzajúca</a>`);
  }
  for (let page = windowStart; page <= windowEnd; page++) {
    links.push(page === state.page
      ? `<span class="pagination-current" aria-current="page">${page}</span>`
      : `<a href="${escapeHtml(archiveQueryUrl(pathname, { ...state, page }))}" aria-label="Strana ${page}">${page}</a>`);
  }
  if (state.page < state.totalPages) {
    links.push(`<a class="pagination-direction" href="${escapeHtml(archiveQueryUrl(pathname, { ...state, page: state.page + 1 }))}">Ďalšia <i class="ph ph-arrow-right" aria-hidden="true"></i></a>`);
  }
  return `<nav class="archive-pagination" aria-label="Stránkovanie">${links.join("")}</nav>`;
}

function renderArchiveItems(items, kind) {
  if (!items.length) {
    return `<div class="archive-empty"><i class="ph ph-magnifying-glass" aria-hidden="true"></i><h2>Nenašli sa žiadne záznamy</h2><p>Skúste kratší názov lokality alebo zrušte filtre.</p></div>`;
  }
  if (kind === "news") return renderSsrNews(items, "", items.length);
  return items.map((item) => item.archiveType === "news"
    ? renderSsrNews([item], "", 1)
    : renderSsrWarnings([item], "", 1)
  ).join("\n");
}

function archiveState(req, items) {
  const query = String(req.query.q || "").trim().slice(0, 80);
  const normalizedQuery = normalizeSearchText(query);
  const requestedSize = Number(req.query.pocet);
  const pageSize = ARCHIVE_PAGE_SIZES.has(requestedSize) ? requestedSize : ARCHIVE_PAGE_SIZE;
  const filtered = normalizedQuery
    ? items.filter((item) => archiveSearchText(item).includes(normalizedQuery))
    : items;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const requestedPage = Math.max(1, Number.parseInt(req.query.strana, 10) || 1);
  const page = Math.min(requestedPage, totalPages);
  return {
    query,
    pageSize,
    page,
    totalPages,
    total: filtered.length,
    items: filtered.slice((page - 1) * pageSize, page * pageSize),
  };
}

function includesLocation(value, locationName) {
  const haystack = normalizeSearchText(value);
  const needle = normalizeSearchText(locationName);
  return Boolean(needle) && ` ${haystack} `.includes(` ${needle} `);
}

function itemBelongsToLocation(item, locationName, type) {
  if (type === "warning") return includesLocation(item.location, locationName);
  return [
    item.place,
    ...(Array.isArray(item.locations) ? item.locations.map((location) => location.place) : []),
    item.title,
    item.snippet,
  ].some((value) =>
    includesLocation(value, locationName)
  );
}

const locationOverviewCache = {
  value: null,
  version: null,
  expiresAt: 0,
  inFlight: null,
};

async function loadLocationOverview() {
  const version = latestContentDate();
  if (
    locationOverviewCache.value &&
    locationOverviewCache.version === version &&
    locationOverviewCache.expiresAt > Date.now()
  ) {
    return locationOverviewCache.value;
  }
  if (locationOverviewCache.inFlight) return locationOverviewCache.inFlight;

  locationOverviewCache.inFlight = (async () => {
    const [warnings, news, gz] = await Promise.all([
      loadWarnings(),
      newsStore.get(),
      loadPlaces(),
    ]);
    const report = buildStatsReport({
      sightings: warnings,
      news,
      gz,
      includeAllLocations: true,
    });
    const locationCandidates = report.allLocations.map((location) => {
      const warningItems = warnings.filter((item) =>
        itemBelongsToLocation(item, location.name, "warning")
      );
      const newsItems = news.filter((item) =>
        itemBelongsToLocation(item, location.name, "news")
      );
      const latest = [
        ...warningItems.map((item) => item.reportedAt),
        ...newsItems.map((item) => item.date),
      ].filter(Boolean).sort().pop() || latestContentDate() || CONTENT_UPDATED;
      return {
        ...location,
        sightings: warningItems.length,
        news: newsItems.length,
        total: warningItems.length + newsItems.length,
        slug: locationSlug(location.name),
        path: locationPath(location.name),
        warningItems,
        newsItems,
        latest,
      };
    });
    const locations = mergeLocationPages(locationCandidates).filter(
      (location) => location.total >= 2
    );
    const overview = {
      warnings,
      news,
      report,
      locations,
      topLocations: locations.slice(0, 12),
    };
    locationOverviewCache.value = overview;
    locationOverviewCache.version = latestContentDate();
    locationOverviewCache.expiresAt = Date.now() + 5 * 60 * 1000;
    return overview;
  })();

  try {
    return await locationOverviewCache.inFlight;
  } finally {
    locationOverviewCache.inFlight = null;
  }
}

function renderLocationLinks(locations, currentSlug = "") {
  return locations
    .filter((location) => location.slug !== currentSlug)
    .map((location) =>
      `<a href="${escapeHtml(location.path)}">${escapeHtml(location.name)} <span aria-label="${location.total} záznamov">(${location.total})</span></a>`
    )
    .join("\n");
}

function renderSsrUpdated(value) {
  if (!value) return "";
  return `Aktualizované <time datetime="${escapeHtml(value)}">${escapeHtml(formatSlovakDate(value, true))}</time>`;
}

function renderHomeStats(overview) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekStart = todayStart - 6 * 86400000;
  const sightings = Array.isArray(overview?.warnings) ? overview.warnings : [];
  const news = Array.isArray(overview?.news) ? overview.news : [];
  const countSince = (items, field, since) => items.filter((item) => {
    const time = new Date(item?.[field] || 0).getTime();
    return Number.isFinite(time) && time >= since;
  }).length;
  const stats = [
    [countSince(sightings, "reportedAt", todayStart), "hlásení dnes"],
    [countSince(sightings, "reportedAt", weekStart), "hlásení za 7 dní"],
    [countSince(news, "date", todayStart), "správ dnes"],
  ];

  return stats
    .map(
      ([value, label]) => `<div class="stat">
        <span class="stat-num">${escapeHtml(value.toLocaleString("sk-SK"))}</span>
        <span class="stat-label">${escapeHtml(label)}</span>
      </div>`
    )
    .join("\n");
}

function renderLocationSummary(location) {
  const first = location.first || location.latest;
  const latest = location.latest || location.first;
  const range = first && latest
    ? `<time datetime="${escapeHtml(first)}">${escapeHtml(formatSlovakDate(first))}</time><span>až</span><time datetime="${escapeHtml(latest)}">${escapeHtml(formatSlovakDate(latest))}</time>`
    : "Dátum nie je dostupný";

  return `<dl class="location-summary" aria-label="Súhrn záznamov pre lokalitu ${escapeHtml(location.name)}">
    <div><dt>Spolu záznamov</dt><dd>${escapeHtml(location.total)}</dd></div>
    <div><dt>Hlásenia a varovania</dt><dd>${escapeHtml(location.sightings)}</dd></div>
    <div><dt>Súvisiace správy</dt><dd>${escapeHtml(location.news)}</dd></div>
    <div class="location-summary-range"><dt>Obdobie záznamov</dt><dd>${range}</dd></div>
  </dl>`;
}

function slovakCount(value, one, few, many) {
  const count = Number(value) || 0;
  const word = count === 1 ? one : count >= 2 && count <= 4 ? few : many;
  return `${count} ${word}`;
}

async function getPageTemplate(file) {
  if (!pageTemplateCache.has(file)) {
    pageTemplateCache.set(file, await readFile(path.join(PUBLIC_DIR, file), "utf8"));
  }
  return pageTemplateCache.get(file);
}

const sightingsStore = new ScheduledDataStore({
  name: "sightings",
  fetcher: fetchSightings,
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

const telegramService = new TelegramService({ config: telegramConfig });
const emailService = new EmailService({ config: emailConfig });

async function flushTelegramNotifications(context) {
  if (!telegramConfig.enabled) return;
  try {
    // Bounded, awaited delivery is important on ephemeral/serverless instances.
    // The durable outbox retains anything not reached in these batches.
    await telegramService.runAvailable(3);
  } catch (err) {
    console.error(`[telegram] ${context} outbox flush failed:`, err.message);
  }
}

async function flushEmailNotifications(context) {
  if (!emailConfig.enabled) return;
  try {
    await emailService.runAvailable(3);
  } catch (err) {
    console.error(`[email] ${context} outbox flush failed:`, err.message);
  }
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY === "true");

// Gzip/deflate odpovedí — JSON z API (až 1000 hlásení + 200 správ) aj
// HTML/CSS/JS sa prenášajú výrazne menšie (~70-85 %).
app.use(compression());

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Základné bezpečnostné a indexačné hlavičky. Verejné JSON API ostáva dostupné,
// administračné a cron URL sa však nemajú objavovať vo výsledkoch vyhľadávania.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(self), camera=(), microphone=()");
  if (
    req.path === "/admin" ||
    req.path.startsWith("/api/admin") ||
    req.path.startsWith("/api/cron") ||
    req.path.startsWith("/api/telegram")
  ) {
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
  if (DISABLE_WEBSITE_LOGS) return false;
  if (req.path.startsWith("/api")) return true;
  return req.method === "GET" && (
    Object.hasOwn(PUBLIC_PAGES, req.path) || req.path.startsWith(LOCATION_ROUTE_PREFIX)
  );
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
    res.status(502).json({ error: "Nepodarilo sa načítať externé hlásenia", detail: err.message });
  }
});

// Zlúčený zoznam medvedích varovaní: externé mapy + schválené
// hlásenia od používateľov / manuálne pridané varovania. Spravodajské články
// zostávajú oddelené v /api/news a nikdy sa nepripájajú k sourceLinks hlásenia.
async function loadWarnings() {
  const [scraped, reports] = await Promise.all([
    sightingsStore.get(),
    loadApprovedBearReports().catch((err) => {
      console.error("[warnings] reports load failed:", err.message);
      return [];
    }),
  ]);

  return mergeWarnings({ sightings: scraped, reports });
}

app.get("/api/warnings", async (_req, res) => {
  try {
    const items = (await loadWarnings()).map((item) => ({
      ...item,
      detailUrl: warningPath(item),
    }));
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
    const items = data.map(({ _scrapedAt, ...item }) => ({
      ...item,
      detailUrl: newsPath(item),
    }));

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
    emailNotificationsEnabled: emailConfig.enabled,
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
const REFRESH_PHASE_LABELS = {
  fetch: "sťahovaní",
  save: "ukladaní",
  reload: "načítaní uložených dát",
  record: "zápise záznamu o obnove",
};

function refreshSourceOutcome(result, store, label) {
  const meta = store.meta;
  const ok = result.status === "fulfilled";
  const error = ok
    ? null
    : result.reason?.message || String(result.reason || "Neznáma chyba");
  const stage = ok
    ? null
    : result.reason?.refreshStage || meta.errorStage || "refresh";

  return {
    label,
    ok,
    status: ok ? "success" : "error",
    itemCount: ok ? meta.lastRun?.itemCount ?? null : null,
    fetchedAt: ok ? meta.fetchedAt : null,
    stage,
    error,
    children: meta.lastRun?.sourceOutcomes || null,
  };
}

function refreshResultMessage(result) {
  const outcomes = Object.values(result.sources).flatMap((source) =>
    source.children ? Object.values(source.children) : [source]
  );
  const successful = outcomes.filter((source) => source.ok).length;
  const header = successful === outcomes.length
    ? "Sťahovanie úspešne dokončené."
    : successful > 0
      ? "Sťahovanie čiastočne dokončené."
      : "Sťahovanie zlyhalo.";
  const details = outcomes.map((source) => {
    if (source.ok) {
      const count = Number.isInteger(source.itemCount) ? ` (${source.itemCount})` : "";
      return `${source.label}: načítané${count}.`;
    }
    const phase = REFRESH_PHASE_LABELS[source.stage] || "obnove";
    return `${source.label}: zlyhalo pri ${phase}, ${source.error}`;
  });
  return [header, ...details].join("\n");
}

async function refreshAll(reason) {
  const [sightingsResult, newsResult] = await Promise.allSettled([
    sightingsStore.refresh(reason),
    newsStore.refresh(reason),
  ]);

  const sources = {
    sightings: refreshSourceOutcome(sightingsResult, sightingsStore, "Hlásenia"),
    news: refreshSourceOutcome(newsResult, newsStore, "Správy"),
  };
  const errors = Object.fromEntries(
    Object.entries(sources).flatMap(([key, source]) => {
      if (!source.ok) return [[key, source.error]];
      if (!source.children) return [];
      return Object.entries(source.children)
        .filter(([, child]) => !child.ok)
        .map(([childKey, child]) => [`${key}.${childKey}`, child.error]);
    })
  );
  const leafOutcomes = Object.values(sources).flatMap((source) =>
    source.children ? Object.values(source.children) : [source]
  );

  // DB triggre vytvorili outbox položky spolu s novým obsahom. Worker
  // zobudíme hneď; interval ostáva poistkou pre retry a reštart procesu.
  await flushTelegramNotifications(`${reason} refresh`);
  await flushEmailNotifications(`${reason} refresh`);

  let indexNow = null;
  if ((sources.sightings.ok || sources.news.ok) && reason !== "startup") {
    const changedPaths = ["/", "/domov", "/spravy", "/varovania", "/stats"];
    try {
      const overview = await loadLocationOverview();
      const { locations } = overview;
      changedPaths.push(...locations.map((location) => location.path));
      changedPaths.push(...overview.news.map((item) => newsPath(item)));
      changedPaths.push(...overview.warnings.map((item) => warningPath(item)));
    } catch (err) {
      console.error("[indexnow] location URLs unavailable:", err.message);
    }
    indexNow = await notifyIndexNow(changedPaths);
  }

  return {
    ok: sources.sightings.ok || sources.news.ok,
    complete: leafOutcomes.every((source) => source.ok),
    supabaseConfigured: isSupabaseConfigured(),
    refreshMode: "external-cron",
    sightings: sightingsStore.meta,
    news: newsStore.meta,
    sources,
    indexNow,
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
    message: refreshResultMessage(result),
  });
});

// Telegram posiela secret v hlavičke nastavenej pri registrácii webhooku.
// Callback navyše prejde kontrolou konkrétneho povoleného súkromného chatu.
app.post("/api/telegram/webhook", async (req, res) => {
  if (!telegramConfig.enabled) return res.status(404).json({ ok: false });
  const receivedSecret = req.get("x-telegram-bot-api-secret-token");
  if (!webhookSecretMatches(telegramConfig.webhookSecret, receivedSecret)) {
    return res.status(401).json({ ok: false });
  }

  try {
    const result = await telegramService.handleUpdate(req.body);
    if (result?.status) {
      await newsStore.loadFromDatabase().catch((err) => {
        console.error("[telegram moderation] news reload failed:", err.message);
      });
      if (result.status === "approved") await flushEmailNotifications("telegram approval");
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error("[telegram webhook] callback failed:", err.message);
    return res.status(500).json({ ok: false });
  }
});

// --- Bear report (public) ---

app.post("/api/reports", async (req, res) => {
  const { location, description, reporterName, reporterEmail, lat, lng, reportedDate } = req.body || {};

  if (!location || typeof location !== "string" || !location.trim()) {
    return res.status(400).json({ ok: false, error: "Lokalita je povinná." });
  }

  try {
    const report = {
      location: location.trim(),
      description: description?.trim() || null,
      reporterName: reporterName?.trim() || null,
      reporterEmail: reporterEmail?.trim() || null,
      lat: Number(lat) || null,
      lng: Number(lng) || null,
      reportedDate: reportedDate || new Date().toISOString(),
    };
    const result = await saveBearReport({
      ...report,
      status: "pending",
    });
    res.json({ ok: true, id: result?.id, published: false, moderationStatus: "pending" });

    // Uloženie je jediná práca, ktorú musí formulár dokončiť pred
    // odpoveďou. AI kontrola nemení stav (hlásenie vždy čaká na
    // moderovanie) a Telegram má trvácny outbox, preto ich spustíme na pozadí.
    telegramService.kick();
    classifyReportSpam(report)
      .then((spamCheck) => {
        console.log(
          `[reports] spam check=${spamCheck.verdict} confidence=${spamCheck.confidence ?? "n/a"} status=pending`
        );
      })
      .catch((error) => {
        console.warn(`[report spam ai] background classification failed: ${error.message}`);
      });
  } catch (err) {
    console.error("[reports] save failed:", err.message);
    res.status(500).json({ ok: false, error: "Nepodarilo sa uložiť hlásenie." });
  }
});

// --- Email subscriptions (public) ---

const subscriptionAttempts = new Map();

function subscriptionRateLimited(req) {
  const key = String(req.ip || req.socket.remoteAddress || "unknown");
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const recent = (subscriptionAttempts.get(key) || []).filter((time) => now - time < windowMs);
  recent.push(now);
  subscriptionAttempts.set(key, recent);
  if (subscriptionAttempts.size > 1000) {
    for (const [candidate, attempts] of subscriptionAttempts) {
      if (!attempts.some((time) => now - time < windowMs)) subscriptionAttempts.delete(candidate);
    }
  }
  return recent.length > 5;
}

function emailActionPage({ title, message, status = 200, action = null }) {
  const actionHtml = action
    ? `<form method="post" action="${escapeHtml(action.url)}"><button type="submit" style="border:0;border-radius:10px;background:#d66a24;color:#fff;padding:13px 20px;font:700 16px Arial;cursor:pointer">${escapeHtml(action.label)}</button></form>`
    : `<p><a href="/" style="color:#365f43;font-weight:700">Späť na mapu</a></p>`;
  return {
    status,
    html: `<!doctype html><html lang="sk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)} – Kde je Medveď</title></head><body style="margin:0;background:#f3f0e8;color:#18221b;font-family:Arial,sans-serif"><main style="max-width:620px;margin:8vh auto;padding:32px;background:#fff;border:1px solid #d9ded8;border-radius:18px"><h1>${escapeHtml(title)}</h1><p style="font-size:17px;line-height:1.65">${escapeHtml(message)}</p>${actionHtml}</main></body></html>`,
  };
}

app.post("/api/subscriptions", async (req, res) => {
  const { email, notifyType, areaName } = req.body || {};

  if (
    !email || typeof email !== "string" || email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  ) {
    return res.status(400).json({ ok: false, error: "Zadajte platnú emailovú adresu." });
  }

  if (notifyType === "area" && (!areaName || !areaName.trim() || areaName.trim().length > 120)) {
    return res.status(400).json({ ok: false, error: "Zadajte oblasť pre upozornenia." });
  }
  if (subscriptionRateLimited(req)) {
    res.set("Retry-After", "900");
    return res.status(429).json({ ok: false, error: "Priveľa pokusov. Skúste to znova o 15 minút." });
  }
  if (!emailConfig.enabled) {
    return res.status(503).json({ ok: false, error: "E-mailové upozornenia momentálne nie sú dostupné." });
  }

  try {
    const subscription = await saveEmailSubscription({
      email: email.trim().toLowerCase(),
      notifyType: notifyType === "area" ? "area" : "all",
      areaName: notifyType === "area" ? areaName.trim() : null,
    });

    if (subscription?.needsConfirmation) {
      await emailService.sendConfirmation(subscription);
      await markEmailConfirmationSent(subscription.id);
    }

    res.json({
      ok: true,
      message: "Ak odber ešte nie je aktívny, skontrolujte si e-mail a potvrďte ho kliknutím na odkaz.",
    });
  } catch (err) {
    console.error("[subscriptions] save failed:", err.message);
    res.status(500).json({ ok: false, error: "Nepodarilo sa odoslať potvrdenie odberu. Skúste to znova." });
  }
});

app.get("/api/subscriptions/confirm", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const verified = verifyEmailToken(token, {
    purpose: "confirm",
    secret: emailConfig.tokenSecret,
  });
  if (!verified) {
    const page = emailActionPage({
      title: "Neplatný odkaz",
      message: "Potvrdzovací odkaz je neplatný alebo vypršal. Vyplňte formulár odberu znova.",
      status: 400,
    });
    return res.status(page.status).type("html").send(page.html);
  }

  try {
    const subscription = await confirmEmailSubscription(verified);
    const page = subscription
      ? emailActionPage({
          title: "Odber je potvrdený",
          message: "E-mailové upozornenia sú aktívne. Budeme posielať iba nové hlásenia podľa vášho výberu.",
        })
      : emailActionPage({
          title: "Odber sa nepotvrdil",
          message: "Odkaz už nie je platný. Vyplňte formulár odberu znova.",
          status: 400,
        });
    return res.status(page.status).type("html").send(page.html);
  } catch (err) {
    console.error("[subscriptions] confirmation failed:", err.message);
    const page = emailActionPage({
      title: "Odber sa nepotvrdil",
      message: "Nastala technická chyba. Skúste potvrdzovací odkaz znova neskôr.",
      status: 500,
    });
    return res.status(page.status).type("html").send(page.html);
  }
});

app.get("/api/subscriptions/unsubscribe", (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const verified = verifyEmailToken(token, {
    purpose: "unsubscribe",
    secret: emailConfig.tokenSecret,
  });
  const page = verified
    ? emailActionPage({
        title: "Zrušiť odber upozornení?",
        message: "Po potvrdení vám už pre tento odber nebudeme posielať ďalšie upozornenia.",
        action: {
          url: `/api/subscriptions/unsubscribe?token=${encodeURIComponent(token)}`,
          label: "Zrušiť odber",
        },
      })
    : emailActionPage({
        title: "Neplatný odkaz",
        message: "Odkaz na zrušenie odberu nie je platný.",
        status: 400,
      });
  return res.status(page.status).type("html").send(page.html);
});

app.post("/api/subscriptions/unsubscribe", async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const verified = verifyEmailToken(token, {
    purpose: "unsubscribe",
    secret: emailConfig.tokenSecret,
  });
  if (!verified) return res.status(400).send("Invalid unsubscribe token");

  try {
    const subscription = await unsubscribeEmailSubscription(verified);
    if (!subscription) return res.status(400).send("Invalid unsubscribe token");
    const page = emailActionPage({
      title: "Odber je zrušený",
      message: "Pre tento odber vám už nebudeme posielať ďalšie upozornenia.",
    });
    return res.status(page.status).type("html").send(page.html);
  } catch (err) {
    console.error("[subscriptions] unsubscribe failed:", err.message);
    return res.status(500).send("Unsubscribe failed");
  }
});

// --- Frontend + technické SEO ---

async function renderPublicPage(req, res, pathname, page) {
  try {
    const origin = siteOrigin(req);
    const hasArchiveParams = (pathname === "/spravy" || pathname === "/varovania") &&
      Boolean(req.query.q || req.query.strana || req.query.pocet);
    const seoPage = hasArchiveParams ? { ...page, robots: "noindex,follow" } : page;
    let html = await getPageTemplate(page.file);
    html = html.replace("<!-- SEO_HEAD -->", buildSeoHead(pathname, seoPage, origin));

    // Mapa a redakčný domov dostanú aj serverom vykreslené aktuálne dáta.
    if (pathname === "/" || pathname === "/domov" || pathname === "/spravy" || pathname === "/varovania") {
      const overview = await loadLocationOverview().catch((err) => {
        console.error("[seo] public overview SSR failed:", err.message);
        return {
          warnings: [],
          news: [],
          locations: [],
          topLocations: [],
          report: { totals: {} },
        };
      });
      if (pathname === "/") {
        html = html
          .replace("<!-- SSR_WARNINGS -->", renderSsrWarnings(overview.warnings, undefined, 6))
          .replace("<!-- SSR_NEWS -->", renderSsrNews(overview.news, undefined, 6))
          .replace("<!-- SSR_WARNING_COUNT -->", escapeHtml(overview.warnings.length))
          .replace("<!-- SSR_NEWS_COUNT -->", escapeHtml(overview.news.length))
          .replace("<!-- SSR_UPDATED -->", renderSsrUpdated(latestContentDate()));
      } else if (pathname === "/domov") {
        html = html
          .replace("<!-- SSR_HOME_STATS -->", renderHomeStats(overview))
          .replace("<!-- SSR_WARNINGS -->", renderSsrWarnings(overview.warnings, undefined, 6))
          .replace("<!-- SSR_NEWS -->", renderSsrNews(overview.news, undefined, 6))
          .replace("<!-- SSR_TOP_LOCATIONS -->", renderLocationLinks(overview.topLocations))
          .replace("<!-- SSR_UPDATED -->", renderSsrUpdated(latestContentDate()));
      } else {
        const archiveItems = pathname === "/spravy"
          ? overview.news
          : warningArchiveItems(overview);
        const state = archiveState(req, archiveItems);
        html = html
          .replace("<!-- ARCHIVE_FILTERS -->", renderArchiveFilters(pathname, state))
          .replace("<!-- ARCHIVE_ITEMS -->", renderArchiveItems(state.items, pathname === "/spravy" ? "news" : "warnings"))
          .replace("<!-- ARCHIVE_PAGINATION -->", renderArchivePagination(pathname, state))
          .replace("<!-- ARCHIVE_COUNT -->", escapeHtml(
            `${slovakCount(state.total, "záznam", "záznamy", "záznamov")}, strana ${state.page} z ${state.totalPages}`
          ))
          .replace("<!-- SSR_UPDATED -->", renderSsrUpdated(latestContentDate()));
      }
    }

    const canonical = absoluteUrl(origin, pathname);
    res.set({
      "Cache-Control": "no-cache",
      "Content-Language": "sk",
      Link: `<${canonical}>; rel="canonical"`,
    });
    const modified = latestContentDate();
    if (modified && ["/", "/spravy", "/varovania"].includes(pathname)) {
      res.set("Last-Modified", new Date(modified).toUTCString());
    }
    res.type("html").send(html);
  } catch (err) {
    console.error(`[frontend] ${pathname} render failed:`, err.message);
    res.status(500).type("text").send("Stránku sa nepodarilo načítať.");
  }
}

async function renderLocationPage(req, res) {
  try {
    const overview = await loadLocationOverview();
    const requestedSlug = locationSlug(req.params.slug);
    const location = overview.locations.find((item) => item.slug === requestedSlug);
    if (!location) {
      return res
        .status(404)
        .set("X-Robots-Tag", "noindex, follow")
        .type("text")
        .send("Pre túto lokalitu zatiaľ nemáme samostatný prehľad.");
    }

    if (req.path !== location.path) return res.redirect(301, location.path);

    const pathname = location.path;
    const origin = siteOrigin(req);
    const page = {
      title: `Výskyt medveďa - ${location.name} | Aktuálne hlásenia`,
      description:
        `Aktuálne hlásenia, varovania a správy o výskyte medveďa v lokalite ${location.name}. ` +
        "Prehľad z viacerých zdrojov s dátumami a pôvodnými odkazmi.",
      schemaType: "CollectionPage",
      breadcrumbName: `Výskyt medveďa - ${location.name}`,
      dateModified: location.latest,
      location,
    };
    let html = await getPageTemplate("location.html");
    html = html
      .replace("<!-- SEO_HEAD -->", buildSeoHead(pathname, page, origin))
      .replaceAll("{{LOCATION_NAME}}", escapeHtml(location.name))
      .replaceAll("<!-- LOCATION_NAME -->", escapeHtml(location.name))
      .replace(
        "<!-- LOCATION_COUNTS -->",
        `${slovakCount(location.sightings, "hlásenie", "hlásenia", "hlásení")} a ` +
        `${slovakCount(location.news, "súvisiaca správa", "súvisiace správy", "súvisiacich správ")} ` +
        "v aktuálnom súbore údajov"
      )
      .replace("<!-- LOCATION_UPDATED -->", renderSsrUpdated(location.latest))
      .replace("<!-- LOCATION_SUMMARY -->", renderLocationSummary(location))
      .replace(
        "<!-- LOCATION_WARNINGS -->",
        renderSsrWarnings(location.warningItems, "Pre túto lokalitu zatiaľ nemáme samostatné hlásenie; súvisí však s ňou spravodajský záznam.")
      )
      .replace(
        "<!-- LOCATION_NEWS -->",
        renderSsrNews(location.newsItems, "Pre túto lokalitu zatiaľ nemáme samostatnú súvisiacu správu.")
      )
      .replace(
        "<!-- LOCATION_RELATED -->",
        renderLocationLinks(overview.topLocations, location.slug)
      );

    const canonical = absoluteUrl(origin, pathname);
    res.set({
      "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
      "Content-Language": "sk",
      "Last-Modified": new Date(location.latest).toUTCString(),
      Link: `<${canonical}>; rel="canonical"`,
    });
    return res.type("html").send(html);
  } catch (err) {
    console.error("[seo] location page render failed:", err.message);
    return res.status(500).type("text").send("Stránku sa nepodarilo načítať.");
  }
}

function findRecordToken(slug) {
  return String(slug || "").match(/-([a-f0-9]{10})$/i)?.[1]?.toLowerCase() || "";
}

function recordLocations(record, recordType) {
  if (recordType === "warning") {
    return normalizeNewsLocations(record.location ? [record.location] : []);
  }
  return normalizeNewsLocations(
    record.locations?.length
      ? record.locations
      : { place: record.place, lat: record.lat, lng: record.lng }
  );
}

function renderDetailLocations(record, recordType, overview) {
  const locations = recordLocations(record, recordType);
  if (!locations.length) return '<p class="record-detail-empty">Lokalita nebola v zdroji spoľahlivo určená.</p>';
  return `<div class="record-detail-locations">${locations.map((location) => {
    const slug = locationSlug(location.place);
    const hasPage = overview.locations.some((item) => item.slug === slug);
    return hasPage
      ? `<a href="${escapeHtml(locationPath(location.place))}"><i class="ph ph-map-pin" aria-hidden="true"></i>${escapeHtml(location.place)}</a>`
      : `<span><i class="ph ph-map-pin" aria-hidden="true"></i>${escapeHtml(location.place)}</span>`;
  }).join("")}</div>`;
}

function detailSource(record, recordType) {
  if (recordType === "warning") {
    const links = sightingSourceLinks(record)
      .map((entry) => ({ ...entry, url: safeHttpUrl(entry.url) }))
      .filter((entry) => entry.url);
    return {
      label: links.length
        ? [...new Set(links.map((entry) => entry.label))].join(" · ")
        : record.source || (record.sourceType === "report" ? "Moderované hlásenie" : "Verejný zdroj"),
      links,
    };
  }
  const url = safeHttpUrl(record.articleUrl || record.link || record.googleNewsUrl || "");
  return {
    label: record.source || "Verejný zdroj",
    links: url ? [{ label: "Otvoriť pôvodný článok", url }] : [],
  };
}

function renderDetailSources(source) {
  if (!source.links.length) {
    return `<p class="record-detail-empty">Pôvodný verejný odkaz nie je pri tomto zázname dostupný.</p>`;
  }
  return `<div class="record-source-actions">${source.links.map((link) =>
    `<a class="btn" href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)} <i class="ph ph-arrow-square-out" aria-hidden="true"></i></a>`
  ).join("")}</div>`;
}

async function renderRecordPage(req, res, requestedKind) {
  try {
    const overview = await loadLocationOverview();
    const token = findRecordToken(req.params.slug);
    let record = null;
    let recordType = requestedKind;

    if (token) {
      if (requestedKind === "news") {
        record = overview.news.find((item) => recordToken(item.id) === token) || null;
        if (record?.category === "warning") return res.redirect(301, newsPath(record));
      } else {
        record = overview.warnings.find((item) => recordToken(item.id) === token) || null;
        if (!record) {
          record = overview.news.find((item) =>
            item.category === "warning" && recordToken(item.id) === token
          ) || null;
          if (record) recordType = "news";
        }
      }
    }

    if (!record) {
      return res.status(404).set("X-Robots-Tag", "noindex, follow").type("text")
        .send("Tento záznam sa nenašiel alebo už nie je verejne dostupný.");
    }

    const canonicalPath = detailPath(record, recordType);
    if (req.path !== canonicalPath) return res.redirect(301, canonicalPath);

    const isNewsArticle = recordType === "news";
    const isWarningPage = requestedKind === "warning";
    const title = record.title || record.location || "Záznam o výskyte medveďa";
    const summary = String(record.summary || record.snippet || record.note || (isNewsArticle
      ? `Správa sa venuje téme „${title}“. Podrobnosti sú dostupné v pôvodnom článku.`
      : "Záznam obsahuje dostupnú lokalitu, dátum a pôvod informácie.")).trim();
    const date = record.date || record.reportedAt || record._scrapedAt || CONTENT_UPDATED;
    const source = detailSource(record, recordType);
    const page = {
      title: `${title.slice(0, 72)} | Kde je Medveď`,
      description: summary.slice(0, 158),
      schemaType: isNewsArticle ? "NewsArticle" : "Article",
      breadcrumbName: isWarningPage ? "Varovania pred medveďmi" : "Správy o medveďoch",
      dateModified: record._scrapedAt || date,
      record: { ...record, summary },
    };
    const relatedPool = requestedKind === "news" ? overview.news : warningArchiveItems(overview);
    const related = relatedPool.filter((item) => String(item.id) !== String(record.id)).slice(0, 4);
    const correction = correctionMailto(record, isWarningPage ? "varovanie" : "správa");
    let html = await getPageTemplate("zaznam.html");
    html = html
      .replace("<!-- SEO_HEAD -->", buildSeoHead(canonicalPath, page, siteOrigin(req)))
      .replaceAll("{{RECORD_TITLE}}", escapeHtml(title))
      .replaceAll("<!-- RECORD_TYPE -->", isWarningPage ? "Varovanie pred medveďom" : "Správa o medveďoch")
      .replace("<!-- RECORD_SUMMARY_HEADING -->", isNewsArticle ? "Súhrn článku" : "Súhrn záznamu")
      .replace("<!-- RECORD_SUMMARY -->", escapeHtml(summary))
      .replace("<!-- RECORD_DATE -->", escapeHtml(formatSlovakDate(date, Boolean(record.reportedAt && record.datePrecision !== "date"))))
      .replace("<!-- RECORD_DATE_ISO -->", escapeHtml(date))
      .replace("<!-- RECORD_SOURCE -->", escapeHtml(source.label))
      .replace("<!-- RECORD_LOCATIONS -->", renderDetailLocations(record, recordType, overview))
      .replace("<!-- RECORD_SOURCES -->", renderDetailSources(source))
      .replace("<!-- RECORD_AI_NOTE -->", record.summaryGeneratedByAi
        ? '<p class="record-ai-note"><i class="ph ph-sparkle" aria-hidden="true"></i>Súhrn bol vytvorený automaticky z dostupného textu zdroja a môže obsahovať nepresnosť. Rozhodujúci je pôvodný článok.</p>'
        : "")
      .replace("<!-- RECORD_RELATED -->", requestedKind === "news"
        ? renderSsrNews(related, "Ďalšie správy momentálne nie sú dostupné.", 4)
        : renderArchiveItems(related, "warnings"))
      .replaceAll("<!-- RECORD_ARCHIVE_URL -->", requestedKind === "news" ? "/spravy" : "/varovania")
      .replaceAll("<!-- RECORD_ARCHIVE_LABEL -->", requestedKind === "news" ? "Všetky správy" : "Všetky varovania")
      .replace("<!-- RECORD_CORRECTION -->", escapeHtml(correction));

    res.set({
      "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
      "Content-Language": "sk",
      "Last-Modified": new Date(record._scrapedAt || date).toUTCString(),
      Link: `<${absoluteUrl(siteOrigin(req), canonicalPath)}>; rel="canonical"`,
    });
    return res.type("html").send(html);
  } catch (err) {
    console.error("[seo] record page render failed:", err.message);
    return res.status(500).type("text").send("Stránku sa nepodarilo načítať.");
  }
}

for (const [pathname, page] of Object.entries(PUBLIC_PAGES)) {
  app.get(pathname, (req, res) => renderPublicPage(req, res, pathname, page));
}

app.get(`${LOCATION_ROUTE_PREFIX}:slug`, renderLocationPage);
app.get(`${NEWS_ROUTE_PREFIX}:slug`, (req, res) => renderRecordPage(req, res, "news"));
app.get(`${WARNING_ROUTE_PREFIX}:slug`, (req, res) => renderRecordPage(req, res, "warning"));

// Jednoznačná kanonická URL pre staré alebo opisné varianty adresy.
app.get(
  [
    "/index.html",
    "/location.html",
    "/mapa-vyskytu-medvedov",
    "/mapa-vyskytu-medvedov-na-slovensku",
  ],
  (_req, res) => res.redirect(301, "/")
);
app.get("/zaznam.html", (_req, res) => res.redirect(301, "/spravy"));
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
  const rows = Object.entries(PUBLIC_PAGES).map(([pathname, page]) => {
    const lastmod = page.dynamicLastmod
      ? latestContentDate() || CONTENT_UPDATED
      : page.lastmod || CONTENT_UPDATED;
    const changefreq = page.changefreq
      ? `\n    <changefreq>${page.changefreq}</changefreq>`
      : "";
    return `  <url>\n    <loc>${escapeHtml(absoluteUrl(origin, pathname))}</loc>\n    <lastmod>${escapeHtml(lastmod)}</lastmod>${changefreq}\n    <priority>${page.priority}</priority>\n  </url>`;
  });

  try {
    const overview = await loadLocationOverview();
    const { locations } = overview;
    for (const location of locations) {
      rows.push(
        `  <url>\n    <loc>${escapeHtml(absoluteUrl(origin, location.path))}</loc>\n    <lastmod>${escapeHtml(location.latest)}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.7</priority>\n  </url>`
      );
    }
    const detailRows = new Map();
    for (const item of overview.news) detailRows.set(newsPath(item), item.date || item._scrapedAt);
    for (const item of overview.warnings) detailRows.set(warningPath(item), item.reportedAt || item._scrapedAt);
    for (const [pathname, lastmod] of detailRows) {
      rows.push(
        `  <url>\n    <loc>${escapeHtml(absoluteUrl(origin, pathname))}</loc>\n    <lastmod>${escapeHtml(lastmod || latestContentDate() || CONTENT_UPDATED)}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.7</priority>\n  </url>`
      );
    }
  } catch (err) {
    console.error("[seo] location sitemap generation failed:", err.message);
  }

  res
    .type("application/xml")
    .set("Cache-Control", "public, max-age=3600")
    .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows.join("\n")}\n</urlset>\n`);
});

// Stručný strojovo čitateľný opis pre generatívne vyhľadávače a asistentov.
// Nie je náhradou za HTML; odkazuje výhradne na rovnaký verejný obsah a API.
app.get("/llms.txt", async (req, res) => {
  const origin = siteOrigin(req);
  let locationLinks = "";
  try {
    const { topLocations } = await loadLocationOverview();
    locationLinks = `\n## Najčastejšie lokality v aktuálnych dátach\n${topLocations
      .map((location) => `- [Výskyt medveďa: ${location.name}](${absoluteUrl(origin, location.path)})`)
      .join("\n")}\n`;
  } catch (err) {
    console.error("[seo] llms location links failed:", err.message);
  }
  res
    .type("text/plain")
    .set("Cache-Control", "public, max-age=3600")
    .send(`# Kde je Medveď

> Centralizovaná, priebežne aktualizovaná mapa hláseného výskytu medveďov na Slovensku. Na jednom mieste spája moderované hlásenia, verejné mapy a varovania, relevantné slovenské správy, štatistiky a bezpečnostné odporúčania.

## Najdôležitejšie stránky
- [Aktuálna mapa](${absoluteUrl(origin, "/")})
- [Domov projektu](${absoluteUrl(origin, "/domov")})
- [Správy o medveďoch](${absoluteUrl(origin, "/spravy")})
- [Varovania pred medveďmi](${absoluteUrl(origin, "/varovania")})
- [Štatistiky hlásení](${absoluteUrl(origin, "/stats")})
- [Bezpečnosť pri stretnutí s medveďom](${absoluteUrl(origin, "/bezpecnost")})
- [Zdroje, metodika a obmedzenia](${absoluteUrl(origin, "/o-mape")})
- [Spomenuli nás](${absoluteUrl(origin, "/spomenuli-nas")})
- [Nahlásiť pozorovanie](${absoluteUrl(origin, "/nahlas")})
${locationLinks}
## Pokryté typy zdrojov
- Používateľské hlásenia odoslané priamo cez Kde je Medveď
- Verejné záznamy z TuMedved.sk, MapaMedvedov.sk a SprejNaMedveda.sk
- Verejné upozornenia ŠOP SR publikované cez PozorMedved.sk
- Relevantné slovenské správy s odkazom na pôvodný článok

## Strojovo čitateľné dáta
- [Aktuálne varovania, JSON](${absoluteUrl(origin, "/api/warnings")})
- [Aktuálne správy, JSON](${absoluteUrl(origin, "/api/news")})
- [Štatistiky, JSON](${absoluteUrl(origin, "/api/stats")})
- [RSS najnovších hlásení](${absoluteUrl(origin, "/feed.xml")})

## Dôležité obmedzenie
Bod na mape označuje miesto a čas nahláseného pozorovania alebo verejného varovania. Nejde o GPS sledovanie zvierat, potvrdenie ich aktuálnej polohy ani úplnú mapu populácie. Dáta sú orientačné a nenahrádzajú pokyny ŠOP SR, Zásahového tímu ani tiesňových zložiek.
`);
});

app.get("/feed.xml", async (req, res) => {
  const origin = siteOrigin(req);
  const warnings = await loadWarnings().catch(() => []);
  const items = warnings.slice(0, 50).map((item) => {
    const title = `${item.location || "Slovensko"}: hlásený výskyt medveďa`;
    const description = [
      `Lokalita: ${item.location || "neuvedená"}.`,
      `Čas hlásenia: ${formatSlovakDate(item.reportedAt, true)}.`,
      item.note ? String(item.note).slice(0, 400) : "",
      "Údaj je orientačný a nepotvrdzuje aktuálnu polohu zvieraťa.",
    ].filter(Boolean).join(" ");
    const detailUrl = absoluteUrl(origin, warningPath(item));
    return `  <item>\n    <title>${escapeHtml(title)}</title>\n    <link>${escapeHtml(detailUrl)}</link>\n    <guid isPermaLink="true">${escapeHtml(detailUrl)}</guid>\n    <pubDate>${new Date(item.reportedAt || Date.now()).toUTCString()}</pubDate>\n    <description>${escapeHtml(description)}</description>\n  </item>`;
  }).join("\n");
  res
    .type("application/rss+xml")
    .set("Cache-Control", "public, max-age=300")
    .send(`<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0">\n<channel>\n  <title>Kde je Medveď: aktuálne hlásenia</title>\n  <link>${escapeHtml(`${origin}/`)}</link>\n  <description>Najnovšie moderované hlásenia výskytu medveďov na Slovensku.</description>\n  <language>sk-SK</language>\n  <lastBuildDate>${new Date(latestContentDate() || Date.now()).toUTCString()}</lastBuildDate>\n${items}\n</channel>\n</rss>\n`);
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
    const [reports, news] = await Promise.all([
      loadBearReports("pending"),
      loadPendingNews(),
    ]);
    res.json({ ok: true, reports, news });
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

function adminInputError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

async function resolveAdminLocations(value, legacy = null) {
  const raw = Array.isArray(value) && value.length ? value : legacy ? [legacy] : [];
  if (raw.length > 12) throw adminInputError("Jedno varovanie môže mať najviac 12 lokalít.");

  const candidates = normalizeNewsLocations(raw);
  if (!candidates.length) {
    throw adminInputError("Pri medvedom varovaní zadajte aspoň jednu lokalitu.");
  }

  const resolved = [];
  for (const candidate of candidates) {
    const location = await resolveAdminLocation(candidate.place, candidate.lat, candidate.lng);
    if (!location) {
      throw adminInputError(
        `Lokalita „${candidate.place}“ sa na Slovensku nenašla. Skontrolujte názov alebo ju vyhľadajte a vyberte zo zoznamu.`
      );
    }
    resolved.push({ place: location.name, lat: location.lat, lng: location.lng });
  }
  return normalizeNewsLocations(resolved);
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

app.get("/api/admin/incidents", adminAuth, async (req, res) => {
  const locality = typeof req.query.locality === "string" ? req.query.locality.trim() : "";
  const eventDate = typeof req.query.eventDate === "string" ? req.query.eventDate.trim() : "";
  const title = typeof req.query.title === "string" ? req.query.title.trim() : "";
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);

  if (!query && (!locality || !eventDate)) {
    return res.status(400).json({
      ok: false,
      error: "Na návrhy zadajte dátum aj lokalitu, alebo vyhľadávací text.",
    });
  }
  if ([locality, title, query].some((value) => value.length > 240)) {
    return res.status(400).json({ ok: false, error: "Vyhľadávanie je príliš dlhé." });
  }

  try {
    const incidents = await loadIncidentSuggestions({
      locality,
      eventDate,
      title,
      query,
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
    });
    res.set("Cache-Control", "private, no-store");
    res.json({ ok: true, incidents });
  } catch (err) {
    console.error("[admin incidents] search failed:", err.message);
    res.status(500).json({ ok: false, error: "Nepodarilo sa vyhľadať existujúce udalosti." });
  }
});

app.post("/api/admin/reports/:id/status", adminAuth, async (req, res) => {
  const { status } = req.body || {};
  if (!["approved", "rejected"].includes(status)) {
    return res.status(400).json({ ok: false, error: "Neplatný stav." });
  }
  try {
    await updateBearReportStatus(Number(req.params.id), status);
    if (status === "approved") await flushEmailNotifications("report approval");
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
    if (status === "approved") await flushEmailNotifications("sighting approval");
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
    await reviewNewsWithAutomaticIncident(req.params.id, {
      status,
      category: "article",
      actor: "admin",
    });
    await newsStore.loadFromDatabase().catch((err) => {
      console.error("[news status] reload failed:", err.message);
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Schválenie správy s kategorizáciou (varovanie/článok) a úpravou lokality.
// Pri 'warning' prijmeme vybraný bod na mape alebo názov geokódujeme.
app.post("/api/admin/news/:id/review", adminAuth, async (req, res) => {
  const { status, category, locations, place, lat, lng } = req.body || {};
  if (!["approved", "rejected"].includes(status)) {
    return res.status(400).json({ ok: false, error: "Neplatný stav." });
  }

  try {
    const fields = { status, actor: "admin" };

    if (status === "approved") {
      const cat = category === "warning" ? "warning" : "article";
      fields.category = cat;
      let warningLocations = [];
      let warningLocation = null;

      if (cat === "warning") {
        warningLocations = await resolveAdminLocations(locations, { place, lat, lng });
        warningLocation = warningLocations[0];
        fields.locations = warningLocations;
        fields.place = warningLocation.place;
        fields.lat = warningLocation.lat;
        fields.lng = warningLocation.lng;
      }

    }

    const incidentResult = await reviewNewsWithAutomaticIncident(req.params.id, fields);
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
      locations: fields.locations || [],
      incident: incidentResult || null,
    });
  } catch (err) {
    console.error("[news review] failed:", err.message);
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

// --- Admin: správa obsahu (všetky správy + hlásenia, editácia) ---

app.get("/api/admin/content", adminAuth, async (_req, res) => {
  try {
    const [news, scrapedSightings, bearReports] = await Promise.all([
      loadAllNews(),
      loadAllSightings(),
      loadAllBearReports(),
    ]);
    const sightings = [...scrapedSightings, ...bearReports].sort(
      (a, b) => new Date(b.reported_at || 0).getTime() - new Date(a.reported_at || 0).getTime()
    );
    res.json({ ok: true, news, sightings });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/admin/news/:id/edit", adminAuth, async (req, res) => {
  try {
    const fields = { ...(req.body || {}) };
    if (fields.category === "warning" && Array.isArray(fields.locations)) {
      fields.locations = await resolveAdminLocations(fields.locations, {
        place: fields.place,
        lat: fields.lat,
        lng: fields.lng,
      });
    } else if (fields.category === "article") {
      fields.locations = [];
    }
    await updateNewsFields(req.params.id, fields);
    await newsStore.loadFromDatabase().catch((err) => {
      console.error("[news edit] reload failed:", err.message);
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("[news edit] failed:", err.message);
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
});

app.post("/api/admin/sightings/:id/edit", adminAuth, async (req, res) => {
  try {
    const reportMatch = /^report-(\d+)$/.exec(req.params.id);
    if (reportMatch) {
      await updateBearReportFields(Number(reportMatch[1]), req.body || {});
    } else {
      await updateSightingFields(req.params.id, req.body || {});
      await sightingsStore.loadFromDatabase().catch((err) => {
        console.error("[sighting edit] reload failed:", err.message);
      });
    }
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
  const { type, title, location, description, source, link, locations, place, lat, lng, date } = req.body || {};

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
      const warningLocations = type === "news-warning"
        ? await resolveAdminLocations(locations, { place, lat, lng })
        : [];
      const primaryLocation = warningLocations[0] || null;

      await saveManualNews({
        id: `manual-news-${Date.now()}`,
        source: source?.trim() || "Manuálne pridané",
        title: cleanTitle,
        link: link?.trim() || null,
        snippet: description?.trim() || null,
        publishedAt: reportedAt.toISOString(),
        category: type === "news-warning" ? "warning" : "article",
        locations: warningLocations,
        place: primaryLocation?.place || null,
        lat: primaryLocation?.lat ?? null,
        lng: primaryLocation?.lng ?? null,
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

    // DB triggre už vytvorili trvácne outbox položky. Workerov zobudíme
    // bez blokovania odpovede formulára; retry a interval ostávajú nezmenené.
    telegramService.kick();
    emailService.kick();
  } catch (err) {
    console.error("[manual warning] save failed:", err.message);
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
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

app.post("/api/admin/refresh", adminAuth, async (req, res) => {
  const result = await refreshAll("admin");
  res.status(result.ok ? 200 : 502).json({
    ...result,
    message: refreshResultMessage(result),
  });
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
    `Supabase: ${isSupabaseConfigured() ? "configured" : "not configured"}; refresh: external cron; Telegram: ${telegramConfig.enabled ? "enabled" : "disabled"}; email: ${emailConfig.enabled ? "enabled" : `disabled (${emailConfig.missing.join(", ") || "Supabase"})`}`
  );
  telegramService.start();
  emailService.start();
  sightingsStore.start().catch((err) => {
    console.error("[sightings] startup load failed:", err.message);
  });
  newsStore.start().catch((err) => {
    console.error("[news] startup load failed:", err.message);
  });

  if (isSupabaseConfigured() && !DISABLE_STARTUP_REFRESH) {
    Promise.all([
      sightingsStore.refresh("startup"),
      newsStore.refresh("startup"),
    ]).catch((err) => {
      console.error("[startup] refresh failed:", err.message);
    });
  }
});
