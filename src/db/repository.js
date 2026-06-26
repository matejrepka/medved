import crypto from "node:crypto";

import { getSupabase, isSupabaseConfigured } from "./supabase.js";

const WRITE_CHUNK_SIZE = 200;
const SIGHTINGS_LIMIT = 1000;
const NEWS_LIMIT = 200;

function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function asNullableNumber(value) {
  return Number.isFinite(value) ? value : null;
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
  const rows = items.map((item) => ({
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

  return (data || [])
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
}

export async function loadNewsLogs() {
  const supabase = getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("news_logs")
    .select(
      "id,source,title,link,google_news_url,article_url,snippet,published_at,place,lat,lng,has_coords,scraped_at"
    )
    .eq("status", "approved")
    .order("published_at", { ascending: false, nullsFirst: false })
    .limit(NEWS_LIMIT);

  if (error) throw error;

  return (data || [])
    .map((row) => ({
      id: row.id,
      source: row.source,
      title: row.title,
      link: row.link,
      googleNewsUrl: row.google_news_url,
      articleUrl: row.article_url,
      snippet: row.snippet || "",
      date: row.published_at,
      place: row.place,
      lat: row.lat,
      lng: row.lng,
      hasCoords: Boolean(row.has_coords),
      _scrapedAt: row.scraped_at,
    }))
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
    .select("id,source,title,link,snippet,published_at,place,status")
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
