import { mergeNewsLocations, normalizeNewsLocations } from "./news-locations.js";

const SOURCE_TYPE_PRIORITY = Object.freeze({
  official_notice: 10,
  local_original: 20,
  national: 30,
  syndication: 40,
  other: 50,
});

export const INCIDENT_SOURCE_TYPES = Object.freeze(Object.keys(SOURCE_TYPE_PRIORITY));

export function normalizeIncidentText(value) {
  return String(value || "")
    .toLocaleLowerCase("sk")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function sourceTypePriority(value) {
  return SOURCE_TYPE_PRIORITY[value] ?? SOURCE_TYPE_PRIORITY.other;
}

export function sourceTypeLabel(value) {
  return {
    official_notice: "Úradné oznámenie",
    local_original: "Miestny alebo priamy zdroj",
    national: "Celoštátne médium",
    syndication: "Prevzatá správa",
    other: "Iný zdroj",
  }[value] || "Iný zdroj";
}

export function inferIncidentSourceType(article = {}) {
  const source = normalizeIncidentText(article.source);
  const url = normalizeIncidentText(article.articleUrl || article.article_url || article.link);
  const combined = `${source} ${url}`;

  if (
    /\b(sop sr|statna ochrana prirody|zasahovy tim|policia|policajny zbor|mestska policia|obec|mesto|mestsky urad|obecny urad)\b/.test(combined) ||
    /\b(sopsr sk|minv sk|policia sk)\b/.test(combined)
  ) {
    return "official_notice";
  }
  if (/\b(tasr|sita|teraz sk|webnoviny)\b/.test(combined)) return "syndication";
  if (/\b(tvn|markiza|joj|rtvs|stvr|sme|pravda|aktuality|dennik n|hnonline|cas sk|topky)\b/.test(combined)) {
    return "national";
  }
  return "local_original";
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateDistanceDays(a, b) {
  const first = parseDate(a);
  const second = parseDate(b);
  if (!first || !second) return null;
  return Math.round(Math.abs(first.getTime() - second.getTime()) / 86400000);
}

function textTokens(value) {
  return new Set(normalizeIncidentText(value).split(" ").filter((token) => token.length >= 4));
}

function tokenSimilarity(a, b) {
  const first = textTokens(a);
  const second = textTokens(b);
  if (!first.size || !second.size) return 0;
  let overlap = 0;
  for (const token of first) if (second.has(token)) overlap += 1;
  return overlap / Math.max(first.size, second.size);
}

function coordinateDistanceKm(latA, lngA, latB, lngB) {
  const values = [latA, lngA, latB, lngB].map(Number);
  if (!values.every(Number.isFinite)) return null;
  const [aLat, aLng, bLat, bLng] = values.map((value) => (value * Math.PI) / 180);
  const dLat = bLat - aLat;
  const dLng = bLng - aLng;
  const haversine = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat) * Math.cos(bLat) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

export function scoreIncidentMatch(incident, criteria = {}) {
  const locality = normalizeIncidentText(criteria.locality || criteria.place);
  const candidateLocality = normalizeIncidentText(incident.locality);
  const days = dateDistanceDays(criteria.eventDate, incident.event_date || incident.eventDate);
  const distanceKm = coordinateDistanceKm(criteria.lat, criteria.lng, incident.lat, incident.lng);
  let score = 0;
  const reasons = [];

  if (locality && candidateLocality) {
    if (locality === candidateLocality) {
      score += 50;
      reasons.push("rovnaká lokalita");
    } else if (locality.includes(candidateLocality) || candidateLocality.includes(locality)) {
      score += 36;
      reasons.push("súvisiaca lokalita");
    }
  }

  if (distanceKm !== null) {
    if (distanceKm <= 2) score += 20;
    else if (distanceKm <= 10) score += 12;
    else if (distanceKm <= 30) score += 5;
    if (distanceKm <= 30) reasons.push(`vzdialenosť ${Math.max(1, Math.round(distanceKm))} km`);
  }

  if (days !== null) {
    if (days === 0) score += 35;
    else if (days <= 3) score += 28;
    else if (days <= 14) score += 18;
    else if (days <= 30) score += 7;
    if (days <= 30) reasons.push(days === 0 ? "rovnaký dátum" : `rozdiel ${days} dní`);
  }

  const similarity = tokenSimilarity(
    [criteria.title, criteria.summary, criteria.query].filter(Boolean).join(" "),
    [incident.title, incident.summary].filter(Boolean).join(" ")
  );
  if (similarity >= 0.15) {
    score += Math.round(Math.min(similarity, 1) * 15);
    reasons.push("podobný obsah");
  }

  return { score, reasons, dateDistanceDays: days, distanceKm };
}

export function rankIncidentSuggestions(incidents, criteria = {}, limit = 6) {
  return (incidents || [])
    .map((incident) => ({ ...incident, match: scoreIncidentMatch(incident, criteria) }))
    .filter((incident) => {
      if (criteria.query) {
        const query = normalizeIncidentText(criteria.query);
        const text = normalizeIncidentText(`${incident.title} ${incident.locality} ${incident.summary || ""}`);
        if (query && text.includes(query)) return true;
      }
      return incident.match.score >= 30;
    })
    .sort((a, b) => b.match.score - a.match.score || String(b.event_date).localeCompare(String(a.event_date)))
    .slice(0, limit);
}

/**
 * Automatic attachment is intentionally stricter than the suggestion list.
 * A match needs the same calendar day plus either the same normalized locality
 * or coordinates within 2 km. A close runner-up makes the result ambiguous.
 */
export function selectAutomaticIncidentMatch(suggestions = [], criteria = {}) {
  const locality = normalizeIncidentText(criteria.locality || criteria.place);
  const eligible = (suggestions || []).filter((incident) => {
    const match = incident.match || scoreIncidentMatch(incident, criteria);
    const sameLocality = locality && normalizeIncidentText(incident.locality) === locality;
    const samePoint = match.distanceKm !== null && match.distanceKm <= 2;
    return match.score >= 85 && match.dateDistanceDays === 0 && (sameLocality || samePoint);
  });

  if (!eligible.length) return null;
  const sorted = [...eligible].sort((a, b) =>
    (b.match?.score || 0) - (a.match?.score || 0)
  );
  const first = sorted[0];
  const second = sorted[1];
  if (second && (first.match?.score || 0) - (second.match?.score || 0) < 15) return null;
  return first;
}

function articlePublicUrl(article) {
  return article.articleUrl || article.article_url || article.googleNewsUrl || article.google_news_url || article.link || null;
}

function publicCoverageArticle(article, link = {}) {
  return {
    id: article.id,
    source: article.source || "Verejný zdroj",
    title: article.title || "Správa o medveďovi",
    publishedAt: article.date || article.published_at || null,
    url: articlePublicUrl(article),
    sourceType: link.source_type || inferIncidentSourceType(article),
    sourceTypeLabel: sourceTypeLabel(link.source_type || inferIncidentSourceType(article)),
    locations: normalizeNewsLocations(article.locations),
  };
}

export function groupNewsByIncidents({ articles = [], incidents = [], links = [] } = {}) {
  const incidentById = new Map(incidents.map((incident) => [String(incident.id), incident]));
  const linkByNewsId = new Map(links.map((link) => [String(link.news_id), link]));
  const groupedArticles = new Map();
  const ungrouped = [];

  for (const article of articles) {
    const link = linkByNewsId.get(String(article.id));
    if (!link || !incidentById.has(String(link.incident_id))) {
      ungrouped.push(article);
      continue;
    }
    const id = String(link.incident_id);
    if (!groupedArticles.has(id)) groupedArticles.set(id, []);
    groupedArticles.get(id).push({ article, link });
  }

  const grouped = [];
  for (const [incidentId, entries] of groupedArticles) {
    const incident = incidentById.get(incidentId);
    const sorted = entries.slice().sort((a, b) => {
      const priority = sourceTypePriority(a.link.source_type) - sourceTypePriority(b.link.source_type);
      if (priority) return priority;
      return new Date(a.article.date || a.article.published_at || 0) - new Date(b.article.date || b.article.published_at || 0);
    });
    const selected = entries.find(({ article }) => String(article.id) === String(incident.primary_news_id)) || sorted[0];
    const primary = selected.article;
    const coverage = sorted.map(({ article, link }) => publicCoverageArticle(article, link));
    const latestScrape = entries
      .map(({ article }) => article._scrapedAt || article.scraped_at)
      .filter(Boolean)
      .sort()
      .pop() || null;
    const articleLocations = mergeNewsLocations(entries.map(({ article }) => article));
    const locations = articleLocations.length
      ? articleLocations
      : normalizeNewsLocations({ place: incident.locality, lat: incident.lat, lng: incident.lng });
    const primaryLocation = locations[0] || null;

    grouped.push({
      id: `incident-${incidentId}`,
      incidentId,
      isIncident: true,
      title: incident.title,
      snippet: incident.summary || primary.summary || primary.snippet || "",
      summary: incident.summary || primary.summary || primary.snippet || "",
      summaryGeneratedByAi: Boolean(primary.summaryGeneratedByAi && !incident.summary),
      date: incident.event_date,
      eventDate: incident.event_date,
      place: primaryLocation?.place || incident.locality,
      lat: primaryLocation?.lat ?? incident.lat,
      lng: primaryLocation?.lng ?? incident.lng,
      hasCoords: Boolean(primaryLocation?.hasCoords) ||
        (Number.isFinite(Number(incident.lat)) && Number.isFinite(Number(incident.lng))),
      locations,
      category: entries.some(({ article }) => article.category === "warning") ? "warning" : "article",
      status: incident.status,
      verificationStatus: incident.verification_status || "reported",
      source: primary.source,
      sourceType: selected.link.source_type,
      sourceTypeLabel: sourceTypeLabel(selected.link.source_type),
      articleUrl: articlePublicUrl(primary),
      sourceCount: coverage.length,
      coverage,
      _scrapedAt: latestScrape,
    });
  }

  return [...grouped, ...ungrouped].sort(
    (a, b) => new Date(b.date || b.published_at || 0) - new Date(a.date || a.published_at || 0)
  );
}
