import crypto from "node:crypto";

import { getSupabase, isSupabaseConfigured } from "./supabase.js";
import { decodeHtmlEntities } from "../html-text.js";
import { dedupeSightings, sightingSourceLinks } from "../sightings-dedupe.js";
import {
  groupNewsByIncidents,
  inferIncidentSourceType,
  rankIncidentSuggestions,
  selectAutomaticIncidentMatch,
} from "../incidents.js";
import { newsLocations, normalizeNewsLocations } from "../news-locations.js";

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

function payloadNewsLocations(row) {
  const payload = row?.payload && typeof row.payload === "object" ? row.payload : {};
  return normalizeNewsLocations(
    payload.locations?.length
      ? payload.locations
      : payload.aiClassification?.places || { place: row?.place, lat: row?.lat, lng: row?.lng }
  );
}

function rowToNews(row, storedLocations = []) {
  const locations = normalizeNewsLocations(
    storedLocations.length ? storedLocations : payloadNewsLocations(row)
  );
  const primary = locations[0] || null;
  const lat = asNullableNumber(primary?.lat ?? row.lat);
  const lng = asNullableNumber(primary?.lng ?? row.lng);
  return {
    id: row.id,
    source: row.source,
    title: decodeHtmlEntities(row.title),
    link: row.link,
    googleNewsUrl: row.google_news_url,
    articleUrl: row.article_url,
    snippet: decodeHtmlEntities(row.snippet || ""),
    date: row.published_at,
    place: primary?.place || row.place,
    lat,
    lng,
    hasCoords: hasCoordinates(lat, lng),
    locations,
    category: newsCategory(row, hasCoordinates(lat, lng)),
    _scrapedAt: row.scraped_at,
  };
}

async function loadNewsWarningLocations(newsIds) {
  const supabase = getSupabase();
  const byNewsId = new Map();
  const unique = [...new Set((newsIds || []).filter(Boolean))];
  if (!supabase || !unique.length) return byNewsId;

  try {
    for (let i = 0; i < unique.length; i += WRITE_CHUNK_SIZE) {
      const { data, error } = await supabase
        .from("news_warning_locations")
        .select("news_id,position,place,lat,lng")
        .in("news_id", unique.slice(i, i + WRITE_CHUNK_SIZE))
        .order("position", { ascending: true });
      if (error) throw error;
      for (const row of data || []) {
        if (!byNewsId.has(row.news_id)) byNewsId.set(row.news_id, []);
        byNewsId.get(row.news_id).push(row);
      }
    }
  } catch (error) {
    if (!isMissingRelation(error)) throw error;
  }
  return byNewsId;
}

async function replaceNewsWarningLocations(newsId, value) {
  const supabase = getSupabase();
  if (!supabase) return false;
  const locations = normalizeNewsLocations(value);

  const { error: deleteError } = await supabase
    .from("news_warning_locations")
    .delete()
    .eq("news_id", newsId);
  if (deleteError) {
    if (isMissingRelation(deleteError)) return false;
    throw deleteError;
  }
  if (!locations.length) return true;

  const { error } = await supabase.from("news_warning_locations").insert(
    locations.map((location, position) => ({
      news_id: newsId,
      position,
      place: location.place,
      lat: location.lat,
      lng: location.lng,
    }))
  );
  if (error) throw error;
  return true;
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

  for (const item of freshItems) {
    const locations = newsLocations(item);
    if (locations.length) await replaceNewsWarningLocations(item.id, locations);
  }

  console.log(`[news] saved ${freshItems.length} new, ${knownIds.size} already known`);
}

// Chyba PostgREST pre neexistujúci stĺpec (napr. status pred migráciou 004).
function isMissingColumn(error) {
  return error?.code === "42703" || /does not exist/i.test(error?.message || "");
}

async function loadIncidentLinksForNews(newsIds, columns) {
  const supabase = getSupabase();
  const rows = [];
  const unique = [...new Set(newsIds.filter(Boolean))];
  for (let i = 0; i < unique.length; i += WRITE_CHUNK_SIZE) {
    const { data, error } = await supabase
      .from("incident_news_links")
      .select(columns)
      .in("news_id", unique.slice(i, i + WRITE_CHUNK_SIZE));
    if (error) throw error;
    rows.push(...(data || []));
  }
  return rows;
}

async function loadIncidentLinksForIncidents(incidentIds, columns) {
  const supabase = getSupabase();
  const rows = [];
  const unique = [...new Set(incidentIds.filter(Boolean))];
  for (let i = 0; i < unique.length; i += WRITE_CHUNK_SIZE) {
    const { data, error } = await supabase
      .from("incident_news_links")
      .select(columns)
      .in("incident_id", unique.slice(i, i + WRITE_CHUNK_SIZE));
    if (error) throw error;
    rows.push(...(data || []));
  }
  return rows;
}

async function loadApprovedNewsRowsByIds(newsIds, columns) {
  const supabase = getSupabase();
  const rows = [];
  const unique = [...new Set(newsIds.filter(Boolean))];
  for (let i = 0; i < unique.length; i += WRITE_CHUNK_SIZE) {
    const { data, error } = await supabase
      .from("news_logs")
      .select(columns)
      .eq("status", "approved")
      .in("id", unique.slice(i, i + WRITE_CHUNK_SIZE));
    if (error) throw error;
    rows.push(...(data || []));
  }
  return rows;
}

function isMissingRelation(error) {
  return (
    error?.code === "42P01" ||
    error?.code === "PGRST205" ||
    /relation .* does not exist|could not find the table/i.test(error?.message || "")
  );
}

async function refreshIncidentPrimaryForNews(newsId) {
  const supabase = getSupabase();
  try {
    const { data: link, error: linkError } = await supabase
      .from("incident_news_links")
      .select("incident_id")
      .eq("news_id", newsId)
      .maybeSingle();
    if (linkError) throw linkError;
    if (link?.incident_id) {
      const { error: refreshError } = await supabase.rpc("refresh_news_incident_primary", {
        p_incident_id: link.incident_id,
      });
      if (refreshError) throw refreshError;
    }
  } catch (incidentError) {
    if (!isMissingRelation(incidentError) && incidentError.code !== "PGRST202") throw incidentError;
  }
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
    "id,source,title,link,google_news_url,article_url,snippet,published_at,place,lat,lng,has_coords,category,payload,scraped_at";

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

  let locationMap = await loadNewsWarningLocations([...rowsById.keys()]);
  const articles = [...rowsById.values()].map((row) => rowToNews(row, locationMap.get(row.id)));
  if (!articles.length) return [];

  // Incident tables are additive. Before migration 006 is deployed, preserve
  // the original public feed instead of failing the entire news endpoint.
  let links = [];
  try {
    links = await loadIncidentLinksForNews(
      articles.map((article) => article.id),
      "incident_id,news_id,source_type,source_priority,attached_at"
    );
  } catch (error) {
    if (!isMissingRelation(error)) throw error;
    return articles.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  }

  const incidentIds = [...new Set(links.map((link) => link.incident_id).filter(Boolean))];
  let incidents = [];
  if (incidentIds.length) {
    // Once one member of an incident reaches the public window, include every
    // approved attached article so the source count and coverage list are exact.
    links = await loadIncidentLinksForIncidents(
      incidentIds,
      "incident_id,news_id,source_type,source_priority,attached_at"
    );
    const missingNewsIds = links
      .map((link) => link.news_id)
      .filter((id) => !rowsById.has(id));
    if (missingNewsIds.length) {
      const coverageRows = await loadApprovedNewsRowsByIds(missingNewsIds, columns);
      for (const row of coverageRows) rowsById.set(row.id, row);
      locationMap = await loadNewsWarningLocations([...rowsById.keys()]);
      articles.splice(
        0,
        articles.length,
        ...[...rowsById.values()].map((row) => rowToNews(row, locationMap.get(row.id)))
      );
    }

    const { data, error } = await supabase
      .from("news_incidents")
      .select("id,event_date,event_date_precision,locality,lat,lng,title,summary,status,verification_status,primary_news_id,created_at,updated_at")
      .in("id", incidentIds);
    if (error) throw error;
    incidents = data || [];
  }

  return groupNewsByIncidents({ articles, incidents, links });
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
  await replaceNewsWarningLocations(item.id, item.category === "warning" ? newsLocations(item) : []);
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
    status: "approved",
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
    .select("id,source,title,link,google_news_url,article_url,snippet,published_at,place,lat,lng,has_coords,category,status,payload,scraped_at,updated_at")
    .eq("status", "pending")
    .order("published_at", { ascending: false, nullsFirst: false })
    .limit(100);

  if (error) throw error;
  const rows = data || [];
  const locationMap = await loadNewsWarningLocations(rows.map((row) => row.id));
  return rows.map((row) => {
    const { payload, ...publicRow } = row;
    return {
      ...publicRow,
      locations: normalizeNewsLocations(
        locationMap.get(row.id)?.length ? locationMap.get(row.id) : payloadNewsLocations(row)
      ),
    };
  });
}

export async function updateNewsStatus(id, status) {
  const supabase = getSupabase();
  if (!supabase) return;

  const { error } = await supabase
    .from("news_logs")
    .update({ status })
    .eq("id", id);

  if (error) throw error;
  await refreshIncidentPrimaryForNews(id);
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
      const locations = normalizeNewsLocations(
        fields.locations?.length
          ? fields.locations
          : { place: fields.place, lat: fields.lat, lng: fields.lng }
      );
      const primary = locations[0] || null;
      const lat = asNullableNumber(primary?.lat);
      const lng = asNullableNumber(primary?.lng);
      update.place = primary?.place || null;
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
  if (fields.status === "approved") {
    await replaceNewsWarningLocations(
      id,
      fields.category === "warning" ? fields.locations : []
    );
  }
  await refreshIncidentPrimaryForNews(id);
}

export async function reviewNewsWithIncident(id, fields) {
  const supabase = getSupabase();
  if (!supabase) return null;

  const params = {
    p_news_id: id,
    p_status: fields.status,
    p_category: fields.category || "article",
    p_place: fields.place || null,
    p_lat: asNullableNumber(fields.lat),
    p_lng: asNullableNumber(fields.lng),
    p_incident_action: fields.incidentAction || "ungrouped",
    p_incident_id: fields.incidentId || null,
    p_event_date: fields.eventDate || null,
    p_event_date_precision: fields.eventDatePrecision || "day",
    p_incident_locality: fields.incidentLocality || null,
    p_incident_lat: asNullableNumber(fields.incidentLat),
    p_incident_lng: asNullableNumber(fields.incidentLng),
    p_incident_title: fields.incidentTitle || null,
    p_incident_summary: fields.incidentSummary || null,
    p_incident_status: fields.incidentStatus || "active",
    p_source_type: fields.sourceType || "other",
    p_actor: fields.actor || "admin",
    p_warning_locations: normalizeNewsLocations(fields.locations),
  };

  const { data, error } = await supabase.rpc("moderate_news_with_incident", params);
  if (!error) return data;

  // Safe rollout path: rejection and explicitly ungrouped approval can retain
  // the legacy moderation behavior until migration 006 is applied. Any action
  // that would create an attachment fails loudly instead of fabricating one.
  const missingRpc =
    error.code === "PGRST202" ||
    error.code === "42883" ||
    /could not find the function/i.test(error.message || "");
  if (missingRpc && (fields.status === "rejected" || params.p_incident_action === "ungrouped")) {
    await reviewNews(id, fields);
    return { status: fields.status, incidentId: null, migrationPending: true };
  }
  if (missingRpc) {
    throw new Error("Zoskupovanie udalostí nie je nasadené. Najprv spustite migráciu 006.");
  }
  throw error;
}

function validExactEventDate(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text
    ? text
    : null;
}

/**
 * Routine moderation path. The moderator approves the independent article;
 * reliable AI facts are then used to attach/create its durable incident.
 * Missing or ambiguous facts deliberately produce an approved ungrouped item.
 */
export async function reviewNewsWithAutomaticIncident(id, fields) {
  const supabase = getSupabase();
  if (!supabase) return null;

  if (fields.status !== "approved") {
    return reviewNewsWithIncident(id, {
      ...fields,
      incidentAction: "ungrouped",
      actor: fields.actor || "admin:auto-cluster",
    });
  }

  const { data: row, error } = await supabase
    .from("news_logs")
    .select("id,source,title,link,google_news_url,article_url,snippet,published_at,payload")
    .eq("id", id)
    .single();
  if (error) throw error;

  const payload = row?.payload && typeof row.payload === "object" ? row.payload : {};
  const analysis = payload.aiClassification && typeof payload.aiClassification === "object"
    ? payload.aiClassification
    : {};
  const eventDate = validExactEventDate(analysis.eventDate);
  const eventDateConfidence = Number(analysis.eventDateConfidence);
  const locations = normalizeNewsLocations(fields.category === "warning" ? fields.locations : []);
  const reliableFacts =
    fields.category === "warning" &&
    locations.length > 0 &&
    eventDate &&
    analysis.eventDatePrecision === "day" &&
    Number.isFinite(eventDateConfidence) &&
    eventDateConfidence >= 0.8;

  const automaticFields = {
    ...fields,
    locations,
    incidentAction: "ungrouped",
    sourceType: inferIncidentSourceType(row),
    actor: fields.actor || "admin:auto-cluster",
  };

  if (!reliableFacts) {
    const result = await reviewNewsWithIncident(id, automaticFields);
    return { ...result, automatic: true, reason: "insufficient_evidence" };
  }

  const matches = new Map();
  let hasAmbiguousCandidate = false;
  for (const location of locations) {
    const criteria = {
      eventDate,
      locality: location.place,
      lat: location.lat,
      lng: location.lng,
      title: row.title,
      summary: row.snippet,
    };
    const suggestions = await loadIncidentSuggestions(criteria);
    if (suggestions.some((incident) => (incident.match?.score || 0) >= 60)) {
      hasAmbiguousCandidate = true;
    }
    const match = selectAutomaticIncidentMatch(suggestions, criteria);
    if (match) matches.set(String(match.id), { incident: match, location });
  }

  if (matches.size === 1) {
    const [{ incident }] = matches.values();
    const result = await reviewNewsWithIncident(id, {
      ...automaticFields,
      incidentAction: "attach",
      incidentId: incident.id,
    });
    return { ...result, automatic: true, reason: "high_confidence_match" };
  }

  if (matches.size > 1 || hasAmbiguousCandidate) {
    const result = await reviewNewsWithIncident(id, automaticFields);
    return { ...result, automatic: true, reason: "ambiguous_match" };
  }

  const primary = locations[0];
  const result = await reviewNewsWithIncident(id, {
    ...automaticFields,
    incidentAction: "create",
    eventDate,
    eventDatePrecision: "day",
    incidentLocality: primary.place,
    incidentLat: primary.lat,
    incidentLng: primary.lng,
    incidentTitle: row.title,
    incidentSummary: row.snippet,
    incidentStatus: "active",
  });
  return { ...result, automatic: true, reason: "new_reliable_incident" };
}

export async function loadIncidentSuggestions(criteria = {}) {
  const supabase = getSupabase();
  if (!supabase) return [];

  let query = supabase
    .from("news_incidents")
    .select("id,event_date,event_date_precision,locality,lat,lng,title,summary,status,verification_status,primary_news_id,updated_at")
    .neq("status", "archived")
    .order("event_date", { ascending: false })
    .limit(200);

  const eventDate = toIso(criteria.eventDate);
  if (eventDate) {
    const center = new Date(eventDate);
    const from = new Date(center.getTime() - 45 * 86400000).toISOString().slice(0, 10);
    const to = new Date(center.getTime() + 45 * 86400000).toISOString().slice(0, 10);
    query = query.gte("event_date", from).lte("event_date", to);
  }

  const { data, error } = await query;
  if (error && isMissingRelation(error)) return [];
  if (error) throw error;

  const ranked = rankIncidentSuggestions(data || [], criteria, 8);
  if (!ranked.length) return [];

  const { data: links, error: linksError } = await supabase
    .from("incident_news_links")
    .select("incident_id")
    .in("incident_id", ranked.map((incident) => incident.id));
  if (linksError) throw linksError;
  const counts = new Map();
  for (const link of links || []) {
    counts.set(link.incident_id, (counts.get(link.incident_id) || 0) + 1);
  }

  return ranked.map((incident) => ({
    ...incident,
    source_count: counts.get(incident.id) || 0,
  }));
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
      "id,source,title,link,google_news_url,article_url,snippet,published_at,place,lat,lng,has_coords,category,status,payload,scraped_at,updated_at"
    )
    .order("published_at", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) throw error;
  const rawRows = data || [];
  const locationMap = await loadNewsWarningLocations(rawRows.map((row) => row.id));
  const rows = rawRows.map((row) => {
    const { payload, ...publicRow } = row;
    return {
      ...publicRow,
      locations: normalizeNewsLocations(
        locationMap.get(row.id)?.length ? locationMap.get(row.id) : payloadNewsLocations(row)
      ),
    };
  });
  if (!rows.length) return rows;

  let links = [];
  try {
    links = await loadIncidentLinksForNews(
      rows.map((row) => row.id),
      "incident_id,news_id,source_type"
    );
  } catch (error) {
    if (isMissingRelation(error)) return rows;
    throw error;
  }
  const byNews = new Map(links.map((link) => [link.news_id, link]));
  return rows.map((row) => {
    const link = byNews.get(row.id);
    return {
      ...row,
      incident_id: link?.incident_id || null,
      incident_source_type: link?.source_type || null,
    };
  });
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
  let locationsToStore = null;

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

  if (fields.category === "article") {
    locationsToStore = [];
    update.place = null;
    update.lat = null;
    update.lng = null;
    update.has_coords = false;
  } else if ("locations" in fields || "place" in fields || "lat" in fields || "lng" in fields) {
    locationsToStore = normalizeNewsLocations(
      fields.locations?.length
        ? fields.locations
        : { place: fields.place, lat: fields.lat, lng: fields.lng }
    );
    const primary = locationsToStore[0] || null;
    update.place = primary?.place || null;
    update.lat = primary?.lat ?? null;
    update.lng = primary?.lng ?? null;
    update.has_coords = Boolean(primary?.hasCoords);
  }

  const { error } = await supabase.from("news_logs").update(update).eq("id", id);
  if (error) throw error;
  if (locationsToStore !== null) await replaceNewsWarningLocations(id, locationsToStore);
  await refreshIncidentPrimaryForNews(id);
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

  const nonce = crypto.randomBytes(24).toString("base64url");
  const row = {
    email: sub.email,
    notify_type: sub.notifyType || "all",
    area_name: sub.areaName || null,
    active: false,
    confirmed_at: null,
    confirmation_nonce: nonce,
    confirmation_sent_at: null,
    unsubscribed_at: null,
    updated_at: new Date().toISOString(),
  };

  const existing = await findEmailSubscription(supabase, row.email, row.area_name);

  if (existing) {
    if (existing.active && existing.confirmed_at) {
      return { ...existing, needsConfirmation: false, alreadyActive: true };
    }

    const lastSent = new Date(existing.confirmation_sent_at || 0).getTime();
    if (Number.isFinite(lastSent) && Date.now() - lastSent < 5 * 60 * 1000) {
      return { ...existing, needsConfirmation: false, confirmationPending: true };
    }

    const { data, error } = await supabase
      .from("email_subscriptions")
      .update({
        notify_type: row.notify_type,
        active: false,
        confirmed_at: null,
        confirmation_nonce: nonce,
        confirmation_sent_at: null,
        unsubscribed_at: null,
        updated_at: row.updated_at,
      })
      .eq("id", existing.id)
      .select("id,email,notify_type,area_name,active,confirmed_at,confirmation_nonce,confirmation_sent_at")
      .single();

    if (error) throw error;
    return { ...data, needsConfirmation: true };
  }

  const { data, error } = await supabase
    .from("email_subscriptions")
    .insert(row)
    .select("id,email,notify_type,area_name,active,confirmed_at,confirmation_nonce,confirmation_sent_at")
    .single();

  if (error) {
    if (isUniqueViolation(error)) {
      const duplicate = await findEmailSubscription(supabase, row.email, row.area_name);
      if (duplicate) return { ...duplicate, needsConfirmation: false, confirmationPending: true };
    }
    throw error;
  }

  return { ...data, needsConfirmation: true };
}

async function findEmailSubscription(supabase, email, areaName) {
  let query = supabase
    .from("email_subscriptions")
    .select("id,email,notify_type,area_name,active,confirmed_at,confirmation_nonce,confirmation_sent_at")
    .eq("email", email)
    .limit(1);

  query = areaName ? query.eq("area_name", areaName) : query.is("area_name", null);

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function markEmailConfirmationSent(id) {
  const supabase = getSupabase();
  if (!supabase) return;
  const { error } = await supabase
    .from("email_subscriptions")
    .update({
      confirmation_sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("active", false);
  if (error) throw error;
}

export async function confirmEmailSubscription({ id, email, nonce }) {
  const supabase = getSupabase();
  if (!supabase) return null;
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("email_subscriptions")
    .update({
      active: true,
      confirmed_at: now,
      unsubscribed_at: null,
      updated_at: now,
    })
    .eq("id", id)
    .eq("email", email)
    .eq("confirmation_nonce", nonce)
    .select("id,email,notify_type,area_name,active,confirmed_at,confirmation_nonce")
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function unsubscribeEmailSubscription({ id, email, nonce }) {
  const supabase = getSupabase();
  if (!supabase) return null;
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("email_subscriptions")
    .update({ active: false, unsubscribed_at: now, updated_at: now })
    .eq("id", id)
    .eq("email", email)
    .eq("confirmation_nonce", nonce)
    .select("id,email,notify_type,area_name,active")
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const { error: cancelError } = await supabase
    .from("email_notification_outbox")
    .update({ status: "cancelled", locked_at: null, updated_at: now })
    .eq("subscription_id", id)
    .in("status", ["pending", "processing"]);
  if (cancelError) throw cancelError;
  return data;
}

function isUniqueViolation(error) {
  return error?.code === "23505" || /duplicate key|unique/i.test(error?.message || "");
}

export async function loadEmailSubscriptions() {
  const supabase = getSupabase();
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("email_subscriptions")
    .select("id,email,notify_type,area_name,active,confirmed_at,confirmation_sent_at,unsubscribed_at,created_at")
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
