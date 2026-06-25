// Medveď Sledovač — server.
//
// Stiahne hlásenia o výskyte medveďov z tumedved.sk a slovenské správy
// o medveďoch, drží ich v cache a poskytuje ako vlastné JSON API.
// Zároveň servíruje frontend zo zložky /public.

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchTumedved } from "./src/scrapers/tumedved.js";
import { fetchNews } from "./src/scrapers/news.js";
import { TtlCache } from "./src/cache.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Platnosť cache: hlásenia 15 min, správy 30 min.
const sightingsCache = new TtlCache(fetchTumedved, 15 * 60 * 1000, "hlasenia");
const newsCache = new TtlCache(fetchNews, 30 * 60 * 1000, "spravy");

const app = express();
app.disable("x-powered-by");

// Malý logger.
app.use((req, _res, next) => {
  if (req.path.startsWith("/api")) console.log(`${req.method} ${req.path}`);
  next();
});

// --- API ---

app.get("/api/sightings", async (_req, res) => {
  try {
    const data = await sightingsCache.get();
    res.set("Cache-Control", "public, max-age=300");
    res.json({ updatedAt: sightingsCache.meta.fetchedAt, count: data.length, items: data });
  } catch (err) {
    res.status(502).json({ error: "Nepodarilo sa stiahnuť hlásenia z tumedved.sk", detail: err.message });
  }
});

app.get("/api/news", async (_req, res) => {
  try {
    const data = await newsCache.get();
    res.set("Cache-Control", "public, max-age=600");
    res.json({ updatedAt: newsCache.meta.fetchedAt, count: data.length, items: data });
  } catch (err) {
    res.status(502).json({ error: "Nepodarilo sa stiahnuť správy", detail: err.message });
  }
});

// Stav + možnosť vynútiť obnovu.
app.get("/api/status", (_req, res) => {
  res.json({ sightings: sightingsCache.meta, news: newsCache.meta });
});

app.post("/api/refresh", async (_req, res) => {
  try {
    const [s, n] = await Promise.all([
      sightingsCache.forceRefresh(),
      newsCache.forceRefresh(),
    ]);
    res.json({ ok: true, sightings: s.length, news: n.length });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// --- Frontend ---
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`\n🐻 Medveď Sledovač beží na http://localhost:${PORT}\n`);
  // Predohrejeme cache, aby prvý návštevník nečakal.
  sightingsCache.get().catch(() => {});
  newsCache.get().catch(() => {});
});
