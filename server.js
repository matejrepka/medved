// Medveď Sledovač — server.
//
// Dáta sa sťahujú výhradne cez externý cron job (cron-job.org), ktorý volá
// /api/cron/refresh každú hodinu. Server pri štarte načíta existujúce dáta
// zo Supabase a servíruje ich cez JSON API + frontend zo zložky /public.

import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchTumedved } from "./src/scrapers/tumedved.js";
import { fetchNews } from "./src/scrapers/news.js";
import { ScheduledDataStore } from "./src/scheduled-store.js";
import { isSupabaseConfigured } from "./src/db/supabase.js";
import {
  deleteEmailSubscription,
  hashIp,
  loadBearReports,
  loadEmailSubscriptions,
  loadNewsLogs,
  loadPendingNews,
  loadTumedvedLogs,
  recordScrapeRun,
  saveBearReport,
  saveEmailSubscription,
  saveNewsLogs,
  saveTumedvedLogs,
  saveWebsiteLog,
  updateBearReportStatus,
  updateNewsStatus,
} from "./src/db/repository.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const CRON_REFRESH_SECRET = process.env.CRON_REFRESH_SECRET;

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
  saveFresh: saveNewsLogs,
  recordRun: recordScrapeRun,
});

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", process.env.TRUST_PROXY === "true");
app.use(express.json());

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
  const [sightingsResult, pozormedvedResult, newsResult] = await Promise.allSettled([
    sightingsStore.refresh(reason),
    pozormedvedStore.refresh(reason),
    newsStore.refresh(reason),
  ]);

  const errors = {};
  if (sightingsResult.status === "rejected") {
    errors.sightings = sightingsResult.reason?.message || String(sightingsResult.reason);
  }
  if (pozormedvedResult.status === "rejected") {
    errors.pozormedved = pozormedvedResult.reason?.message || String(pozormedvedResult.reason);
  }
  if (newsResult.status === "rejected") {
    errors.news = newsResult.reason?.message || String(newsResult.reason);
  }

  return {
    ok: sightingsResult.status === "fulfilled" || pozormedvedResult.status === "fulfilled" || newsResult.status === "fulfilled",
    supabaseConfigured: isSupabaseConfigured(),
    refreshMode: "external-cron",
    sightings: sightingsStore.meta,
    pozormedved: pozormedvedStore.meta,
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

// --- Frontend ---
app.get("/nahlas", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "nahlas.html"));
});

app.get("/privacy", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "privacy.html"));
});

app.get("/terms", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "terms.html"));
});

app.get("/stats", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "stats.html"));
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

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`\n🐻 Medveď Sledovač beží na http://localhost:${PORT}\n`);
  console.log(
    `Supabase: ${isSupabaseConfigured() ? "configured" : "not configured"}; refresh: external cron`
  );
  sightingsStore.start().catch((err) => {
    console.error("[tumedved] startup load failed:", err.message);
  });
  pozormedvedStore.start().catch((err) => {
    console.error("[pozormedved] startup load failed:", err.message);
  });
  newsStore.start().catch((err) => {
    console.error("[news] startup load failed:", err.message);
  });

  if (isSupabaseConfigured()) {
    Promise.all([
      sightingsStore.refresh("startup"),
      pozormedvedStore.refresh("startup"),
      newsStore.refresh("startup"),
    ]).catch((err) => {
      console.error("[startup] refresh failed:", err.message);
    });
  }
});
