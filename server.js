// Medveď Sledovač — server.
//
// Stiahne hlásenia o výskyte medveďov z tumedved.sk a slovenské správy
// o medveďoch na serveri, uloží ich do Supabase a poskytuje ako vlastné JSON API.
// Zároveň servíruje frontend zo zložky /public.

import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchTumedved } from "./src/scrapers/tumedved.js";
import { fetchNews } from "./src/scrapers/news.js";
import { ScheduledDataStore } from "./src/scheduled-store.js";
import { isSupabaseConfigured } from "./src/db/supabase.js";
import {
  hashIp,
  loadNewsLogs,
  loadTumedvedLogs,
  recordScrapeRun,
  saveNewsLogs,
  saveTumedvedLogs,
  saveWebsiteLog,
} from "./src/db/repository.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const SCRAPE_INTERVAL_MS = readMinutesEnv("SCRAPE_INTERVAL_MINUTES", 60) * 60 * 1000;

const sightingsStore = new ScheduledDataStore({
  name: "tumedved",
  fetcher: fetchTumedved,
  loadStored: loadTumedvedLogs,
  saveFresh: saveTumedvedLogs,
  recordRun: recordScrapeRun,
  intervalMs: SCRAPE_INTERVAL_MS,
});

const newsStore = new ScheduledDataStore({
  name: "news",
  fetcher: fetchNews,
  loadStored: loadNewsLogs,
  saveFresh: saveNewsLogs,
  recordRun: recordScrapeRun,
  intervalMs: SCRAPE_INTERVAL_MS,
});

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY === "true");

function readMinutesEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// Malý logger.
app.use((req, _res, next) => {
  if (req.path.startsWith("/api")) console.log(`${req.method} ${req.path}`);
  next();
});

function shouldLogWebsiteRequest(req) {
  if (req.path.startsWith("/api")) return true;
  return req.method === "GET" && ["/", "/privacy", "/terms"].includes(req.path);
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

app.get("/api/news", async (_req, res) => {
  try {
    const data = await newsStore.get();
    res.set("Cache-Control", "public, max-age=300");
    res.json({ updatedAt: newsStore.meta.fetchedAt, count: data.length, items: data });
  } catch (err) {
    res.status(502).json({ error: "Nepodarilo sa stiahnuť správy", detail: err.message });
  }
});

// Stav serverového obnovovania dát.
app.get("/api/status", (_req, res) => {
  res.json({
    supabaseConfigured: isSupabaseConfigured(),
    scrapeIntervalMinutes: SCRAPE_INTERVAL_MS / 60 / 1000,
    sightings: sightingsStore.meta,
    news: newsStore.meta,
  });
});

app.post("/api/refresh", async (_req, res) => {
  try {
    await Promise.all([
      sightingsStore.loadFromDatabase(),
      newsStore.loadFromDatabase(),
    ]);
    res.status(202).json({
      ok: true,
      message: "Dáta sa sťahujú automaticky na serveri podľa hodinového plánu.",
      sightings: sightingsStore.meta,
      news: newsStore.meta,
    });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// --- Frontend ---
app.get("/privacy", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "privacy.html"));
});

app.get("/terms", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "terms.html"));
});

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`\n🐻 Medveď Sledovač beží na http://localhost:${PORT}\n`);
  console.log(
    `Supabase: ${isSupabaseConfigured() ? "configured" : "not configured"}; scrape interval: ${
      SCRAPE_INTERVAL_MS / 60 / 1000
    } min`
  );
  sightingsStore.start().catch(() => {});
  newsStore.start().catch(() => {});
});

process.on("SIGINT", () => {
  sightingsStore.stop();
  newsStore.stop();
  process.exit(0);
});
