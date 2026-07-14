import crypto from "node:crypto";

import { getSupabase, isSupabaseConfigured } from "./supabase.js";
import { decodeHtmlEntities } from "../html-text.js";
import { dedupeSightings, sightingSourceLinks } from "../sightings-dedupe.js";

const WRITE_CHUNK_SIZE = 200;
const SIGHTINGS_LIMIT = 1000;
const NEWS_LIMIT = 200;
const NEWS_MAP_LIMIT = 500;
const TRUSTED_SIGHTING_SOURCES = new Set([
  "tumedved",
  "mapamedvedov",
  "sprejnamedveda",
  "tumedved.sk",
  "mapamedvedov.sk",
  "sprejnamedveda.sk",
]);

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

function rowToSighting(row) {
  const payload = row?.payload && typeof row.payload === "object" ? row.payload : {};
  const item = {
    id: row.id,
    source: row.source,
    sourceKey: payload.sourceKey,
    sourceType: payload.sourceType,
    location: row.location,
    note: row.note || "",
    lat: row.lat,
    lng: row.lng,
    hasCoords: Boolean(row.has_coords),
    reportedAt: row.reported_at,
    datePrecision: payload.datePrecision,
    url: row.url,
    sourceLinks: payload.sourceLinks,
    _scrapedAt: row.scraped_at,
  };
  item.sourceLinks = sightingSourceLinks(item);
  return item;
}

function sourceLinkIdentity(link) {
  return link.sourceId
    ? `${link.key}|id:${link.sourceId}`
    : `${link.key}|url:${link.url}`;
}

function normalizedSource(value) {
  return String(value || "").trim().toLowerCase().replace(/^www\./, "");
}

export function isTrustedSighting(item) {
  const candidates = [item?.sourceKey, item?.source];
  for (const link of sightingSourceLinks(item || {})) {
    candidates.push(link?.key, link?.label);
    try {
      candidates.push(new URL(link?.url).hostname);
    } catch {
      // Neplatná URL sama osebe nikdy nevytvorí dôveryhodný zdroj.
    }
  }
  try {
    candidates.push(new URL(item?.url).hostname);
  } catch {
    // Zdrojové kľúče scraperov sú dostatočné aj bez URL.
  }
  return candidates.some((value) => TRUSTED_SIGHTING_SOURCES.has(normalizedSource(value)));
}

export function sightingStatus(item, existingStatus) {
  // Ručné zamietnutie adminom má prednosť aj pri ďalšom scrapingu.
  if (existingStatus === "rejected") return "rejected";
  if (isTrustedSighting(item)) return "approved";
  return existingStatus || "pending";
}

async function loadSightingsForMerge() {
  const supabase = getSupabase();
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("tumedved_logs")
    .select("id,source,location,note,lat,lng,has_coords,reported_at,url,payload,scraped_at")
    .order("reported_at", { ascending: false, nullsFirst: false })
    .limit(2000);
  if (error) throw error;
  return (data || []).map(rowToSighting);
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

// Vráti množinu id hlásení, ktoré admin ručne upravil. Odolné voči chýbajúcemu
// stĺpcu manually_edited (migrácia 003 ešte nemusela prebehnúť) — vtedy vráti
// prázdnu množinu a scraping pokračuje normálne.
async function loadManuallyEditedSightingIds(ids) {
  const supabase = getSupabase();
  const edited = new Set();
  if (!supabase) return edited;

  const unique = [...new Set(ids.filter(Boolean))];
  try {
    for (let i = 0; i < unique.length; i += WRITE_CHUNK_SIZE) {
      const chunk = unique.slice(i, i + WRITE_CHUNK_SIZE);
      const { data, error } = await supabase
        .from("tumedved_logs")
        .select("id")
        .eq("manually_edited", true)
        .in("id", chunk);
      if (error) throw error;
      for (const row of data || []) edited.add(row.id);
    }
  } catch (err) {
    console.warn(`[tumedved] manually_edited check skipped: ${err.message}`);
    return new Set();
  }

  return edited;
}

// Vráti Map id -> status pre existujúce hlásenia. Odolné voči chýbajúcemu
// stĺpcu status (migrácia 004 ešte nemusela prebehnúť) — vtedy vráti null, čo
// signalizuje, že moderácia hlásení nie je aktívna a ukladáme po starom.
async function loadSightingStatuses(ids) {
  const supabase = getSupabase();
  const map = new Map();
  if (!supabase) return map;

  const unique = [...new Set(ids.filter(Boolean))];
  try {
    for (let i = 0; i < unique.length; i += WRITE_CHUNK_SIZE) {
      const chunk = unique.slice(i, i + WRITE_CHUNK_SIZE);
      const { data, error } = await supabase
        .from("tumedved_logs")
        .select("id,status")
        .in("id", chunk);
      if (error) throw error;
      for (const row of data || []) map.set(row.id, row.status);
    }
  } catch (err) {
    console.warn(`[tumedved] status column check skipped: ${err.message}`);
    return null;
  }

  return map;
}

export async function saveTumedvedLogs(items, scrapedAt = new Date().toISOString()) {
  // Porovnaj čerstvé dáta aj s databázou. Ak je napr. TuMedveď dočasne
  // nedostupný, záznam z ďalšej mapy sa stále pripojí k už uloženému bodu.
  const stored = await loadSightingsForMerge();
  const incomingIds = new Set(items.map((item) => String(item.id || "")).filter(Boolean));
  const incomingLinks = new Set(items.flatMap(sightingSourceLinks).map(sourceLinkIdentity));
  // Čerstvá položka s rovnakým stabilným ID nahrádza svoju staršiu podobu.
  // Inak by pri rovnakej priorite mohol zostať dlhší, ale už neaktuálny text.
  const storedWithoutFreshCopies = stored.filter((item) =>
    !incomingIds.has(String(item.id || ""))
  );
  const deduped = dedupeSightings([...storedWithoutFreshCopies, ...items]).filter((item) =>
    incomingIds.has(String(item.id || "")) ||
    sightingSourceLinks(item).some((link) => incomingLinks.has(sourceLinkIdentity(link)))
  );

  // Hlásenia, ktoré admin ručne upravil, pri scrapingu NEprepisujeme — inak by
  // sa úprava stratila hneď pri ďalšom behu (tabuľka sa inak prepisuje upsertom).
  const editedIds = await loadManuallyEditedSightingIds(deduped.map((item) => item.id));
  const candidates = deduped.filter((item) => !editedIds.has(item.id));

  // Záznamy z troch priamo integrovaných verejných máp schválime automaticky.
  // Ručne zamietnuté záznamy ostávajú zamietnuté a prípadný budúci neznámy
  // zdroj ostane pending. Ak migrácia 004 ešte nebežala, statuses je null →
  // ukladáme bez stĺpca status.
  const statuses = await loadSightingStatuses(candidates.map((item) => item.id));

  const rows = candidates.map((item) => {
    const row = {
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
    };
    if (statuses) row.status = sightingStatus(item, statuses.get(item.id));
    return row;
  });

  await upsertChunks("tumedved_logs", rows, { onConflict: "id" });

  if (editedIds.size) {
    console.log(`[tumedved] preserved ${editedIds.size} manually edited sightings`);
  }
}

// Vráti množinu id správ, ktoré už v news_logs existujú — bez ohľadu na status
// (pending / approved / rejected). Slúži na overenie, čo už bolo zapísané.
async function loadKnownNewsIds(ids) {
  const supabase = getSupabase();
  const known = new Set();
  if (!supabase) return known;

  const unique = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < unique.length; i += WRITE_CHUNK_SIZE) {
    const chunk = unique.slice(i, i + WRITE_CHUNK_SIZE);
    const { data, error } = await supabase.from("news_logs").select("id").in("id", chunk);
    if (error) throw error;
    for (const row of data || []) known.add(row.id);
  }

  return known;
}

// Uloží len NAOZAJ NOVÉ správy. Najprv si overí, ktoré id už v databáze sú
// (vrátane tých, ktoré admin zamietol), a tie preskočí. Vďaka tomu:
//  - zamietnuté správy ostávajú uložené so status='rejected' a pri ďalšom
//    scrapingu sa nevyhodnotia znova ako nové (neobjavia sa späť v moderácii),
//  - schválené ani rozpracované (pending) správy sa neprepíšu späť na pending.
// Každý nový článok sa zapíše ako 'pending' a čaká na moderáciu.
export async function saveNewsLogs(items, scrapedAt = new Date().toISOString(), options = {}) {
  const supabase = getSupabase();
  if (!supabase || !items.length) return;

  const knownIds = await loadKnownNewsIds(items.map((item) => item.id));
  const freshItems = items.filter((item) => item.id && !knownIds.has(item.id));

  if (!freshItems.length) {
    console.log(`[news] no new articles — all ${items.length} already in DB`);
    return;
  }

  // Drahšie/limitované spracovanie (AI) beží až po odfiltrovaní známych ID,
  // takže sa pri pravidelnom crone neopakuje nad tými istými článkami.
  if (typeof options.prepareFresh === "function") {
    try {
      await options.prepareFresh(freshItems);
    } catch (err) {
      console.warn(`[news] fresh-item preparation failed: ${err.message}`);
    }
  }

  const rows = freshItems.map((item) => ({
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
    category: item.category === "warning" ? "warning" : "article",
    status: "pending",
    payload: item,
    scraped_at: scrapedAt,
    updated_at: scrapedAt,
  }));

  // ignoreDuplicates je poistka proti súbehu — keby ten istý článok medzitým
  // pribudol, nech zápis nespadne na konflikte primárneho kľúča.
  await upsertChunks("news_logs", rows, { onConflict: "id", ignoreDuplicates: true });

  console.log(`[news] saved ${freshItems.length} new, ${knownIds.size} already known`);
}

// Chyba PostgREST pre neexistujúci stĺpec (napr. status pred migráciou 004).
function isMissingColumn(error) {
  return error?.code === "42703" || /does not exist/i.test(error?.message || "");
}

export async function loadTumedvedLogs() {
  const supabase = getSupabase();
  if (!supabase) return [];

  const columns = "id,source,location,note,lat,lng,has_coords,reported_at,url,payload,scraped_at";
  // Na mape/API zobrazujeme len schválené hlásenia.
  let { data, error } = await supabase
    .from("tumedved_logs")
    .select(columns)
    .eq("status", "approved")
    .order("reported_at", { ascending: false, nullsFirst: false })
    .limit(SIGHTINGS_LIMIT);

  // Migrácia 004 (stĺpec status) ešte nebežala — načítaj všetko po starom.
  if (error && isMissingColumn(error)) {
    ({ data, error } = await supabase
      .from("tumedved_logs")
      .select(columns)
      .order("reported_at", { ascending: false, nullsFirst: false })
      .limit(SIGHTINGS_LIMIT));
  }

  if (error) throw error;

  const items = (data || [])
    .map(rowToSighting)
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
        title: decodeHtmlEntities(row.title),
        link: row.link,
        googleNewsUrl: row.google_news_url,
        articleUrl: row.article_url,
        snippet: decodeHtmlEntities(row.snippet || ""),
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

// --- Bear reports (user-submitted, AI spam check before moderation) ---

export async function saveBearReport(report) {
  const supabase = getSupabase();
  if (!supabase) return null;

  const approved = report.status === "approved";
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
      status: approved ? "approved" : "pending",
      reviewed_at: approved ? new Date().toISOString() : null,
    })
    .select("id")
    .single();

  if (error) throw error;
  return data;
}

// Schválené hlásenia od používateľov (a manuálne pridané varovania) v rovnakom
// tvare ako hlásenia z tumedved_logs, nech sa dajú zlúčiť do jedného zoznamu.
export async function loadApprovedBearReports() {
  const supabase = getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("bear_reports")
    .select("id,location,description,lat,lng,has_coords,reported_date,created_at")
    .eq("status", "approved")
    .order("reported_date", { ascending: false, nullsFirst: false })
    .limit(500);

  if (error) throw error;

  return (data || []).map((row) => {
    const lat = asNullableNumber(row.lat);
    const lng = asNullableNumber(row.lng);
    return {
      id: `report-${row.id}`,
      sourceType: "report",
      source: "Hlásenie používateľa",
      location: row.location,
      note: row.description || "",
      lat,
      lng,
      hasCoords: hasCoordinates(lat, lng),
      reportedAt: row.reported_date || row.created_at,
      url: null,
    };
  });
}

// --- Manuálne pridané položky z administrácie ---

export async function saveManualNews(item) {
  const supabase = getSupabase();
  if (!supabase) return;

  const now = new Date().toISOString();
  const { error } = await supabase.from("news_logs").insert({
    id: item.id,
    source: item.source || null,
    title: item.title,
    link: item.link || null,
    snippet: item.snippet || null,
    published_at: toIso(item.publishedAt) || now,
    place: item.place || null,
    lat: asNullableNumber(item.lat),
    lng: asNullableNumber(item.lng),
    has_coords: hasCoordinates(item.lat, item.lng),
    status: "approved",
    category: item.category === "warning" ? "warning" : "article",
    payload: { manual: true },
    scraped_at: now,
    updated_at: now,
  });

  if (error) throw error;
}

export async function saveManualTumedved(item) {
  const supabase = getSupabase();
  if (!supabase) return;

  const now = new Date().toISOString();
  const { error } = await supabase.from("tumedved_logs").insert({
    id: item.id,
    source: "tumedved.sk",
    location: item.location,
    note: item.note || null,
    lat: asNullableNumber(item.lat),
    lng: asNullableNumber(item.lng),
    has_coords: hasCoordinates(item.lat, item.lng),
    reported_at: toIso(item.reportedAt) || now,
    url: item.url || null,
    payload: {
      manual: true,
      sourceKey: "tumedved",
      sourceLinks: item.url
        ? [{ key: "tumedved", label: "tumedved.sk", url: item.url, sourceId: item.id }]
        : [],
    },
    scraped_at: now,
    updated_at: now,
  });

  if (error) throw error;
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

export async function updateSightingStatus(id, status) {
  const supabase = getSupabase();
  if (!supabase) return;

  const { error } = await supabase
    .from("tumedved_logs")
    .update({ status, updated_at: new Date().toISOString() })
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

// --- Admin: správa obsahu (zoznam + editácia všetkých záznamov) ---

const ADMIN_NEWS_LIMIT = 1000;
const ADMIN_SIGHTINGS_LIMIT = 2000;

// Všetky správy pre admin správu obsahu — každý status, najnovšie prvé.
export async function loadAllNews({ limit = ADMIN_NEWS_LIMIT } = {}) {
  const supabase = getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("news_logs")
    .select(
      "id,source,title,link,google_news_url,article_url,snippet,published_at,place,lat,lng,has_coords,category,status,scraped_at,updated_at"
    )
    .order("published_at", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

// Všetky hlásenia (tumedved) pre admin správu obsahu — najnovšie prvé.
export async function loadAllSightings({ limit = ADMIN_SIGHTINGS_LIMIT } = {}) {
  const supabase = getSupabase();
  if (!supabase) return [];

  const withStatus =
    "id,source,location,note,lat,lng,has_coords,reported_at,url,status,scraped_at,updated_at";
  let { data, error } = await supabase
    .from("tumedved_logs")
    .select(withStatus)
    .order("reported_at", { ascending: false, nullsFirst: false })
    .limit(limit);

  // Migrácia 004 (stĺpec status) ešte nebežala — načítaj bez neho.
  if (error && isMissingColumn(error)) {
    ({ data, error } = await supabase
      .from("tumedved_logs")
      .select("id,source,location,note,lat,lng,has_coords,reported_at,url,scraped_at,updated_at")
      .order("reported_at", { ascending: false, nullsFirst: false })
      .limit(limit));
  }

  if (error) throw error;
  return data || [];
}

// Editácia správy adminom — prepíše len povolené polia. Súradnice posielame z
// formulára vždy oba naraz, takže has_coords vieme prepočítať spoľahlivo.
export async function updateNewsFields(id, fields) {
  const supabase = getSupabase();
  if (!supabase) return;

  const update = { updated_at: new Date().toISOString() };

  if (typeof fields.title === "string") update.title = fields.title.trim() || null;
  if (typeof fields.source === "string") update.source = fields.source.trim() || null;
  if (typeof fields.snippet === "string") update.snippet = fields.snippet.trim() || null;
  if (typeof fields.link === "string") update.link = fields.link.trim() || null;
  if (typeof fields.place === "string") update.place = fields.place.trim() || null;
  if ("publishedAt" in fields) update.published_at = toIso(fields.publishedAt);
  if ("lat" in fields) update.lat = asNullableNumber(fields.lat);
  if ("lng" in fields) update.lng = asNullableNumber(fields.lng);
  if (fields.category === "warning" || fields.category === "article") {
    update.category = fields.category;
  }
  if (["pending", "approved", "rejected"].includes(fields.status)) {
    update.status = fields.status;
  }
  if ("lat" in update && "lng" in update) {
    update.has_coords = hasCoordinates(update.lat, update.lng);
  }

  const { error } = await supabase.from("news_logs").update(update).eq("id", id);
  if (error) throw error;
}

// Editácia hlásenia adminom. Nastaví manually_edited = true, aby ho scraper pri
// ďalšom behu neprepísal (vyžaduje migráciu 003).
export async function updateSightingFields(id, fields) {
  const supabase = getSupabase();
  if (!supabase) return;

  const update = { updated_at: new Date().toISOString(), manually_edited: true };

  if (typeof fields.location === "string") update.location = fields.location.trim() || null;
  if (typeof fields.note === "string") update.note = fields.note.trim() || null;
  if (typeof fields.source === "string") update.source = fields.source.trim() || null;
  if (typeof fields.url === "string") update.url = fields.url.trim() || null;
  if ("reportedAt" in fields) update.reported_at = toIso(fields.reportedAt);
  if ("lat" in fields) update.lat = asNullableNumber(fields.lat);
  if ("lng" in fields) update.lng = asNullableNumber(fields.lng);
  if (["pending", "approved", "rejected"].includes(fields.status)) {
    update.status = fields.status;
  }
  if ("lat" in update && "lng" in update) {
    update.has_coords = hasCoordinates(update.lat, update.lng);
  }

  const { error } = await supabase.from("tumedved_logs").update(update).eq("id", id);
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
