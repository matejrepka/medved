import crypto from "node:crypto";

import { getSupabase, isSupabaseConfigured } from "./supabase.js";
import { dedupeSightings } from "../sightings-dedupe.js";

const WRITE_CHUNK_SIZE = 200;
const SIGHTINGS_LIMIT = 1000;
const NEWS_LIMIT = 200;
const NEWS_MAP_LIMIT = 500;

function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function asNullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function hasCoordinates(lat, lng) {
  return asNullableNumber(lat) !== null && asNullableNumber(lng) !== null;
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function looksLikeBearWarning(row, hasCoords) {
  if (!hasCoords) return false;
  if (String(row.id || "").startsWith("news-pm")) return true;
  if (normalizeText(row.source).includes("pozormedved")) return true;

  const text = normalizeText([row.title, row.snippet].filter(Boolean).join(" "));
  return (
    /\bupozornen/.test(text) ||
    /\bpozor\b/.test(text) ||
    /\bvaruj/.test(text) ||
    /\bvystrah/.test(text) ||
    /vyskyt.{0,40}medved|medved.{0,40}vyskyt/.test(text) ||
    /pohybuje.{0,40}medved|medved.{0,40}pohybuje/.test(text) ||
    /spozor|pozorovan|zaznamen|nahlas|hlasili/.test(text) ||
    /napad|utoc|zran|usmrtil|zabil/.test(text) ||
    /intravilan|pri obci|v obci|v meste|pri meste/.test(text)
  );
}

function newsCategory(row, hasCoords) {
  if (row.category === "warning") return "warning";
  return looksLikeBearWarning(row, hasCoords) ? "warning" : "article";
}

async function upsertChunks(table, rows, options) {
  if (!rows.length) return;
  const supabase = getSupabase();
  if (!supabase) return;

  for (let i = 0; i < rows.length; i += WRITE_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + WRITE_CHUNK_SIZE);
    const { error } = await supabase.from(table).upsert(chunk, options);
    if (error) throw error;
  }
}

export async function saveTumedvedLogs(items, scrapedAt = new Date().toISOString()) {
  const rows = dedupeSightings(items).map((item) => ({
    id: item.id,
    source: item.source || "tumedved.sk",
    location: item.location || null,
    note: item.note || null,
    lat: asNullableNumber(item.lat),
    lng: asNullableNumber(item.lng),
    has_coords: Boolean(item.hasCoords),
    reported_at: toIso(item.reportedAt),
    url: item.url || null,
    payload: item,
    scraped_at: scrapedAt,
    updated_at: scrapedAt,
  }));

  await upsertChunks("tumedved_logs", rows, { onConflict: "id" });
}

export async function saveNewsLogs(items, scrapedAt = new Date().toISOString()) {
  const rows = items.map((item) => ({
    id: item.id,
    source: item.source || null,
    title: item.title || null,
    link: item.link || null,
    google_news_url: item.googleNewsUrl || null,
    article_url: item.articleUrl || null,
    snippet: item.snippet || null,
    published_at: toIso(item.date),
    place: item.place || null,
    lat: asNullableNumber(item.lat),
    lng: asNullableNumber(item.lng),
    has_coords: Boolean(item.hasCoords),
    status: "pending",
    payload: item,
    scraped_at: scrapedAt,
    updated_at: scrapedAt,
  }));

  await upsertChunks("news_logs", rows, { onConflict: "id", ignoreDuplicates: true });
}

export async function loadTumedvedLogs() {
  const supabase = getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("tumedved_logs")
    .select("id,source,location,note,lat,lng,has_coords,reported_at,url,scraped_at")
    .order("reported_at", { ascending: false, nullsFirst: false })
    .limit(SIGHTINGS_LIMIT);

  if (error) throw error;

  const items = (data || [])
    .map((row) => ({
      id: row.id,
      source: row.source,
      location: row.location,
      note: row.note || "",
      lat: row.lat,
      lng: row.lng,
      hasCoords: Boolean(row.has_coords),
      reportedAt: row.reported_at,
      url: row.url,
      _scrapedAt: row.scraped_at,
    }))
    .sort((a, b) => new Date(b.reportedAt || 0) - new Date(a.reportedAt || 0));

  return dedupeSightings(items);
}

export async function loadNewsLogs() {
  const supabase = getSupabase();
  if (!supabase) return [];

  const columns =
    "id,source,title,link,google_news_url,article_url,snippet,published_at,place,lat,lng,has_coords,category,scraped_at";

  const [approvedResult, warningResult, mapCandidateResult] = await Promise.all([
    supabase
      .from("news_logs")
      .select(columns)
      .eq("status", "approved")
      .order("published_at", { ascending: false, nullsFirst: false })
      .limit(NEWS_LIMIT),
    supabase
      .from("news_logs")
      .select(columns)
      .eq("status", "approved")
      .eq("category", "warning")
      .order("published_at", { ascending: false, nullsFirst: false })
      .limit(NEWS_MAP_LIMIT),
    supabase
      .from("news_logs")
      .select(columns)
      .eq("status", "approved")
      .eq("has_coords", true)
      .order("published_at", { ascending: false, nullsFirst: false })
      .limit(NEWS_MAP_LIMIT),
  ]);

  if (approvedResult.error) throw approvedResult.error;
  if (warningResult.error) throw warningResult.error;
  if (mapCandidateResult.error) throw mapCandidateResult.error;

  // API potrebuje posledné správy pre zoznam a zároveň všetky mapové varovania.
  // Legacy riadky spred kategórie majú často len has_coords=true, preto ich
  // primiešame tiež a pri mapovaní nižšie normalizujeme na "warning".
  const rowsById = new Map();
  for (const row of [
    ...(approvedResult.data || []),
    ...(warningResult.data || []),
    ...(mapCandidateResult.data || []),
  ]) {
    rowsById.set(row.id, row);
  }

  return [...rowsById.values()]
    .map((row) => {
      const lat = asNullableNumber(row.lat);
      const lng = asNullableNumber(row.lng);
      return {
        id: row.id,
        source: row.source,
        title: row.title,
        link: row.link,
        googleNewsUrl: row.google_news_url,
        articleUrl: row.article_url,
        snippet: row.snippet || "",
        date: row.published_at,
        place: row.place,
        lat,
        lng,
        hasCoords: hasCoordinates(lat, lng),
        category: newsCategory(row, hasCoordinates(lat, lng)),
        _scrapedAt: row.scraped_at,
      };
    })
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
}

export async function recordScrapeRun(run) {
  const supabase = getSupabase();
  if (!supabase) return;

  const { error } = await supabase.from("scrape_runs").insert({
    source: run.source,
    status: run.status,
    reason: run.reason || null,
    item_count: Number.isFinite(run.itemCount) ? run.itemCount : null,
    error_message: run.errorMessage || null,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
  });

  if (error) throw error;
}

// --- Bear reports (user-submitted, pending moderation) ---

export async function saveBearReport(report) {
  const supabase = getSupabase();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("bear_reports")
    .insert({
      reporter_name: report.reporterName || null,
      reporter_email: report.reporterEmail || null,
      location: report.location,
      description: report.description || null,
      lat: asNullableNumber(report.lat),
      lng: asNullableNumber(report.lng),
      has_coords: Boolean(report.lat && report.lng),
      reported_date: toIso(report.reportedDate),
      status: "pending",
    })
    .select("id")
    .single();

  if (error) throw error;
  return data;
}

export async function loadBearReports(status) {
  const supabase = getSupabase();
  if (!supabase) return [];

  let query = supabase
    .from("bear_reports")
    .select("id,reporter_name,reporter_email,location,description,lat,lng,has_coords,reported_date,status,created_at,reviewed_at")
    .order("created_at", { ascending: false })
    .limit(200);

  if (status) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function updateBearReportStatus(id, status) {
  const supabase = getSupabase();
  if (!supabase) return;

  const { error } = await supabase
    .from("bear_reports")
    .update({ status, reviewed_at: new Date().toISOString() })
    .eq("id", id);

  if (error) throw error;
}

export async function loadPendingNews() {
  const supabase = getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("news_logs")
    .select("id,source,title,link,snippet,published_at,place,lat,lng,has_coords,category,status")
    .eq("status", "pending")
    .order("published_at", { ascending: false, nullsFirst: false })
    .limit(100);

  if (error) throw error;
  return data || [];
}

export async function updateNewsStatus(id, status) {
  const supabase = getSupabase();
  if (!supabase) return;

  const { error } = await supabase
    .from("news_logs")
    .update({ status })
    .eq("id", id);

  if (error) throw error;
}

// Schválenie/zamietnutie správy s kategorizáciou. Pri 'warning' uložíme lokalitu
// (zobrazí sa na mape), pri 'article' lokalitu vyčistíme (len v zozname správ).
export async function reviewNews(id, fields) {
  const supabase = getSupabase();
  if (!supabase) return;

  const update = {
    status: fields.status,
    updated_at: new Date().toISOString(),
  };

  if (fields.status === "approved") {
    const category = fields.category === "warning" ? "warning" : "article";
    update.category = category;

    if (category === "warning") {
      const lat = asNullableNumber(fields.lat);
      const lng = asNullableNumber(fields.lng);
      update.place = fields.place || null;
      update.lat = lat;
      update.lng = lng;
      update.has_coords = hasCoordinates(lat, lng);
    } else {
      update.place = null;
      update.lat = null;
      update.lng = null;
      update.has_coords = false;
    }
  }

  const { error } = await supabase.from("news_logs").update(update).eq("id", id);
  if (error) throw error;
}

// --- Email subscriptions ---

export async function saveEmailSubscription(sub) {
  const supabase = getSupabase();
  if (!supabase) return null;

  const row = {
    email: sub.email,
    notify_type: sub.notifyType || "all",
    area_name: sub.areaName || null,
    active: true,
  };

  const existing = await findEmailSubscription(supabase, row.email, row.area_name);

  if (existing) {
    const { data, error } = await supabase
      .from("email_subscriptions")
      .update({
        notify_type: row.notify_type,
        active: true,
      })
      .eq("id", existing.id)
      .select("id")
      .single();

    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from("email_subscriptions")
    .insert(row)
    .select("id")
    .single();

  if (error) {
    if (isUniqueViolation(error)) {
      const duplicate = await findEmailSubscription(supabase, row.email, row.area_name);
      if (duplicate) return duplicate;
    }
    throw error;
  }

  return data;
}

async function findEmailSubscription(supabase, email, areaName) {
  let query = supabase
    .from("email_subscriptions")
    .select("id")
    .eq("email", email)
    .limit(1);

  query = areaName ? query.eq("area_name", areaName) : query.is("area_name", null);

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data || null;
}

function isUniqueViolation(error) {
  return error?.code === "23505" || /duplicate key|unique/i.test(error?.message || "");
}

export async function loadEmailSubscriptions() {
  const supabase = getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("email_subscriptions")
    .select("id,email,notify_type,area_name,active,created_at")
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) throw error;
  return data || [];
}

export async function deleteEmailSubscription(id) {
  const supabase = getSupabase();
  if (!supabase) return;

  const { error } = await supabase
    .from("email_subscriptions")
    .delete()
    .eq("id", id);

  if (error) throw error;
}

export function hashIp(ip) {
  const salt = process.env.WEBSITE_LOG_IP_SALT;
  if (!ip || !salt) return null;
  return crypto.createHash("sha256").update(`${salt}:${ip}`).digest("hex");
}

export async function saveWebsiteLog(log) {
  if (!isSupabaseConfigured()) return;
  const supabase = getSupabase();
  if (!supabase) return;

  const { error } = await supabase.from("website_logs").insert({
    method: log.method,
    path: log.path,
    status_code: log.statusCode,
    response_ms: log.responseMs,
    user_agent: log.userAgent || null,
    referer: log.referer || null,
    ip_hash: log.ipHash || null,
  });

  if (error) throw error;
}
