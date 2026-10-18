// Explicit offline maintenance only. Never import into the HTTP server.
import { getSupabase } from "../../src/db/supabase.js";
import { reviewNewsWithIncident, loadIncidentSuggestions } from "../../src/db/repository.js";
import { decideAutomaticIncidentMatch, deriveIncidentDateFacts, inferIncidentSourceType,
  isSubstantiveIncidentSummary } from "../../src/incidents.js";
import { normalizeNewsLocations } from "../../src/news-locations.js";

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
    .select("id,source,title,link,google_news_url,article_url,snippet,published_at,scraped_at,payload")
    .eq("id", id)
    .single();
  if (error) throw error;

  const payload = row?.payload && typeof row.payload === "object" ? row.payload : {};
  const analysis = payload.aiClassification && typeof payload.aiClassification === "object"
    ? payload.aiClassification
    : {};
  const locations = normalizeNewsLocations(fields.category === "warning" ? fields.locations : []);
  const facts = deriveIncidentDateFacts({
    analysis,
    category: fields.category,
    publishedAt: row.published_at,
    scrapedAt: row.scraped_at,
  });

  const automaticFields = {
    ...fields,
    locations,
    incidentAction: "ungrouped",
    sourceType: inferIncidentSourceType(row),
    actor: fields.actor || "admin:auto-cluster",
  };

  if (fields.category !== "warning" || !locations.length || !facts) {
    const result = await reviewNewsWithIncident(id, automaticFields);
    return { ...result, automatic: true, reason: "insufficient_evidence" };
  }

  // The first location describes the primary event. Further places frequently
  // provide context about other weekend incidents and must not veto a correct
  // match for the article's main subject.
  const primary = locations[0];
  const analysisPlaces = Array.isArray(analysis.places) ? analysis.places : [];
  const focusedAiSummary = analysisPlaces.length <= 1 &&
    isSubstantiveIncidentSummary(payload.aiSummary, row.title)
    ? payload.aiSummary
    : null;
  const matchingSummary = focusedAiSummary || row.snippet;
  const criteria = {
    eventDate: facts.eventDate,
    datePrecision: facts.precision,
    locality: primary.place,
    lat: primary.lat,
    lng: primary.lng,
    title: row.title,
    summary: matchingSummary,
  };
  const suggestions = await loadIncidentSuggestions(criteria);
  const decision = decideAutomaticIncidentMatch(suggestions, criteria);

  if (decision.match) {
    const result = await reviewNewsWithIncident(id, {
      ...automaticFields,
      incidentAction: "attach",
      incidentId: decision.match.id,
    });
    return { ...result, automatic: true, reason: "high_confidence_match" };
  }

  if (decision.ambiguous) {
    const result = await reviewNewsWithIncident(id, automaticFields);
    return { ...result, automatic: true, reason: "ambiguous_match" };
  }

  const result = await reviewNewsWithIncident(id, {
    ...automaticFields,
    incidentAction: "create",
    eventDate: facts.eventDate,
    eventDatePrecision: facts.precision,
    incidentLocality: primary.place,
    incidentLat: primary.lat,
    incidentLng: primary.lng,
    incidentTitle: row.title,
    incidentSummary: matchingSummary,
    incidentStatus: "active",
  });
  return {
    ...result,
    automatic: true,
    reason: facts.precision === "day" ? "new_reliable_incident" : "new_approximate_incident",
  };
}

