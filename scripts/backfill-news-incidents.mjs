import "dotenv/config";

import { pathToFileURL } from "node:url";

import { classifyFreshNews } from "../src/ai/news-classifier.js";
import { getSupabase } from "../src/db/supabase.js";
import {
  loadIncidentSuggestions,
  reviewNewsWithAutomaticIncident,
  reviewNewsWithIncident,
} from "../src/db/repository.js";
import {
  inferIncidentSourceType,
  normalizeIncidentText,
  scoreIncidentMatch,
} from "../src/incidents.js";
import { normalizeNewsLocations } from "../src/news-locations.js";
import { fetchArticleBody, fetchDirectArticle } from "../src/scrapers/article.js";

const FETCH_CONCURRENCY = 5;
const FETCH_TIMEOUT_MS = 12_000;
const PAGE_SIZE = 1000;

function isoDay(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

export function historicalEventFacts(row, analysis = {}, fetchedPublishedAt = null) {
  analysis = analysis && typeof analysis === "object" ? analysis : {};
  const exactDate = /^\d{4}-\d{2}-\d{2}$/.test(String(analysis.eventDate || ""))
    ? analysis.eventDate
    : null;
  const confidence = Number(analysis.eventDateConfidence);

  if (
    analysis.category === "warning" &&
    exactDate &&
    analysis.eventDatePrecision === "day" &&
    Number.isFinite(confidence) &&
    confidence >= 0.8
  ) {
    return { eventDate: exactDate, precision: "day", source: "ai" };
  }

  const publicationDay = isoDay(row.published_at || fetchedPublishedAt);
  if (publicationDay) {
    return { eventDate: publicationDay, precision: "approximate", source: "publication" };
  }

  const firstSeenDay = isoDay(row.scraped_at);
  return firstSeenDay
    ? { eventDate: firstSeenDay, precision: "approximate", source: "scrape" }
    : null;
}

export function selectApproximateHistoricalMatch(suggestions = [], criteria = {}) {
  const locality = normalizeIncidentText(criteria.locality || criteria.place);
  if (!locality || !criteria.eventDate) return null;

  const eligible = suggestions
    .map((incident) => ({
      ...incident,
      match: incident.match || scoreIncidentMatch(incident, criteria),
    }))
    .filter((incident) =>
      incident.event_date === criteria.eventDate &&
      normalizeIncidentText(incident.locality) === locality &&
      incident.match.score >= 90
    )
    .sort((a, b) => b.match.score - a.match.score);

  if (!eligible.length) return null;
  if (eligible[1] && eligible[0].match.score - eligible[1].match.score < 15) return null;
  return eligible[0];
}

export function selectUndatedHistoricalMatch(suggestions = [], criteria = {}) {
  const locality = normalizeIncidentText(criteria.locality || criteria.place);
  if (!locality) return null;

  const eligible = suggestions
    .map((incident) => ({
      ...incident,
      match: incident.match || scoreIncidentMatch(incident, { ...criteria, eventDate: null }),
    }))
    .filter((incident) =>
      normalizeIncidentText(incident.locality) === locality && incident.match.score >= 70
    )
    .sort((a, b) => b.match.score - a.match.score);

  if (!eligible.length) return null;
  if (eligible.length === 1) return eligible[0];
  if (eligible[0].match.score < 73 || eligible[0].match.score - eligible[1].match.score < 5) {
    return null;
  }
  return eligible[0];
}

async function mapConcurrent(items, concurrency, worker) {
  const output = new Array(items.length);
  let next = 0;

  async function runWorker() {
    while (next < items.length) {
      const index = next++;
      output[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker())
  );
  return output;
}

async function loadCandidates(db, limit) {
  const { data: rows, error } = await db
    .from("news_logs")
    .select(
      "id,source,title,link,google_news_url,article_url,snippet,published_at,place,lat,lng,category,status,payload,scraped_at"
    )
    .eq("status", "approved")
    .eq("category", "warning")
    .order("published_at", { ascending: true, nullsFirst: false })
    .limit(PAGE_SIZE);
  if (error) throw error;

  const ids = (rows || []).map((row) => row.id);
  if (!ids.length) return [];

  const [{ data: links, error: linksError }, { data: storedLocations, error: locationsError }] =
    await Promise.all([
      db.from("incident_news_links").select("news_id").in("news_id", ids),
      db
        .from("news_warning_locations")
        .select("news_id,position,place,lat,lng")
        .in("news_id", ids)
        .order("position", { ascending: true }),
    ]);
  if (linksError) throw linksError;
  if (locationsError) throw locationsError;

  const linkedIds = new Set((links || []).map((link) => link.news_id));
  const locationsByNews = new Map();
  for (const location of storedLocations || []) {
    if (!locationsByNews.has(location.news_id)) locationsByNews.set(location.news_id, []);
    locationsByNews.get(location.news_id).push(location);
  }

  return (rows || [])
    .filter((row) => !linkedIds.has(row.id))
    .slice(0, limit)
    .map((row) => {
      const stored = locationsByNews.get(row.id) || [];
      const legacy = normalizeNewsLocations({ place: row.place, lat: row.lat, lng: row.lng });
      const aiPlaces = row.payload?.aiClassification?.places || [];
      return {
        ...row,
        locations: normalizeNewsLocations(
          stored.length ? stored : legacy.length ? legacy : aiPlaces
        ),
      };
    });
}

async function fetchHistoricalArticle(row) {
  if (row.article_url) return fetchDirectArticle(row.article_url, FETCH_TIMEOUT_MS);
  if (row.link) return fetchArticleBody(row.link, FETCH_TIMEOUT_MS);
  return { body: "", publishedAt: null };
}

async function refreshHistoricalAnalysis(rows) {
  console.log(`[backfill] fetching ${rows.length} historical article bodies`);
  const fetched = await mapConcurrent(rows, FETCH_CONCURRENCY, async (row, index) => {
    const article = await fetchHistoricalArticle(row);
    if ((index + 1) % 10 === 0 || index + 1 === rows.length) {
      console.log(`[backfill] fetched ${index + 1}/${rows.length}`);
    }
    return article;
  });

  const items = rows.map((row, index) => {
    const item = {
      id: row.id,
      source: row.source,
      title: row.title,
      snippet: row.snippet,
      publishedAt: row.published_at || fetched[index]?.publishedAt,
      place: row.place,
      lat: row.lat,
      lng: row.lng,
      locations: row.locations,
      category: "warning",
    };
    Object.defineProperty(item, "_analysisBody", {
      value: String(fetched[index]?.body || "").slice(0, 12_000),
      enumerable: false,
    });
    return item;
  });

  await classifyFreshNews(items, {
    // The database already contains moderator-approved coordinates. The
    // backfill needs event facts, not a second geocoding pass.
    resolveLocation: async () => null,
  });

  return rows.map((row, index) => ({
    row,
    fetchedPublishedAt: fetched[index]?.publishedAt || null,
    analysis:
      items[index].aiClassification?.category === "warning"
        ? items[index].aiClassification
        : row.payload?.aiClassification || null,
  }));
}

async function persistAnalysis(db, row, analysis) {
  if (!analysis) return;
  const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
  const { error } = await db
    .from("news_logs")
    .update({ payload: { ...payload, aiClassification: analysis } })
    .eq("id", row.id);
  if (error) throw error;
}

async function clusterExact(row, facts) {
  return reviewNewsWithAutomaticIncident(row.id, {
    status: "approved",
    category: "warning",
    locations: row.locations,
    actor: "backfill:auto-cluster",
  });
}

async function clusterApproximate(row, facts) {
  const primary = row.locations[0];
  const criteria = {
    eventDate: facts.eventDate,
    locality: primary.place,
    lat: primary.lat,
    lng: primary.lng,
    title: row.title,
    summary: row.snippet,
  };
  const matchCriteria = facts.source === "scrape" ? { ...criteria, eventDate: null } : criteria;
  const suggestions = await loadIncidentSuggestions(matchCriteria);
  const match = facts.source === "scrape"
    ? selectUndatedHistoricalMatch(suggestions, matchCriteria)
    : selectApproximateHistoricalMatch(suggestions, criteria);
  const common = {
    status: "approved",
    category: "warning",
    locations: row.locations,
    sourceType: inferIncidentSourceType(row),
    actor: "backfill:approximate-date",
  };

  if (match) {
    return reviewNewsWithIncident(row.id, {
      ...common,
      incidentAction: "attach",
      incidentId: match.id,
    });
  }

  return reviewNewsWithIncident(row.id, {
    ...common,
    incidentAction: "create",
    eventDate: facts.eventDate,
    eventDatePrecision: "approximate",
    incidentLocality: primary.place,
    incidentLat: primary.lat,
    incidentLng: primary.lng,
    incidentTitle: row.title,
    incidentSummary: row.snippet,
    incidentStatus: "active",
  });
}

export async function runBackfill({ apply = false, limit = PAGE_SIZE, refreshAi = true } = {}) {
  const db = getSupabase();
  if (!db) throw new Error("Supabase is not configured.");

  const rows = await loadCandidates(db, limit);
  console.log(`[backfill] ${rows.length} approved, unlinked warning articles found`);
  if (!rows.length) return { candidates: 0, clustered: 0, skipped: 0, failed: 0 };

  const prepared = refreshAi
    ? await refreshHistoricalAnalysis(rows)
    : rows.map((row) => ({
        row,
        fetchedPublishedAt: null,
        analysis: row.payload?.aiClassification || null,
      }));

  const plan = prepared.map(({ row, analysis, fetchedPublishedAt }) => ({
    row,
    analysis,
    facts: historicalEventFacts(row, analysis, fetchedPublishedAt),
  }));
  const summary = {
    candidates: plan.length,
    exact: plan.filter((item) => item.facts?.precision === "day").length,
    approximate: plan.filter((item) => item.facts?.precision === "approximate").length,
    withoutDate: plan.filter((item) => !item.facts).length,
    clustered: 0,
    skipped: 0,
    failed: 0,
    created: 0,
    attached: 0,
    ambiguous: 0,
  };

  if (!apply) {
    console.log(JSON.stringify({ mode: "dry-run", ...summary }, null, 2));
    return summary;
  }

  for (const [index, item] of plan.entries()) {
    const { row, analysis, facts } = item;
    try {
      await persistAnalysis(db, row, analysis);
      if (!facts || !row.locations.length) {
        summary.skipped += 1;
        console.warn(`[backfill] skipped ${row.id}: missing date or location`);
        continue;
      }

      const result = facts.precision === "day"
        ? await clusterExact(row, facts)
        : await clusterApproximate(row, facts);

      if (!result?.incidentId) {
        summary.skipped += 1;
        if (result?.reason === "ambiguous_match") summary.ambiguous += 1;
      } else {
        summary.clustered += 1;
        if (result.action === "incident_created") summary.created += 1;
        else summary.attached += 1;
      }
    } catch (error) {
      summary.failed += 1;
      console.error(`[backfill] ${row.id} failed: ${error.message}`);
    }

    if ((index + 1) % 10 === 0 || index + 1 === plan.length) {
      console.log(`[backfill] processed ${index + 1}/${plan.length}`);
    }
  }

  console.log(JSON.stringify({ mode: "apply", ...summary }, null, 2));
  return summary;
}

function parseArgs(argv) {
  const limitArg = argv.find((arg) => arg.startsWith("--limit="));
  const parsedLimit = Number(limitArg?.slice("--limit=".length));
  return {
    apply: argv.includes("--apply"),
    refreshAi: !argv.includes("--skip-ai"),
    limit: Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, PAGE_SIZE) : PAGE_SIZE,
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  runBackfill(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(`[backfill] fatal: ${error.message}`);
    process.exitCode = 1;
  });
}
