import { normalizeNewsLocations } from "./news-locations.js";

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
    /\b(sopsr sk|minv sk|policia sk|pozormedved sk)\b/.test(combined)
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

function isoDay(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/**
 * Prefer an AI-extracted event day only when its own confidence is strong.
 * Otherwise keep the article groupable with a clearly labelled approximate
 * publication/first-seen date instead of leaving it permanently unbucketed.
 */
export function deriveIncidentDateFacts({
  analysis = {},
  category = "warning",
  publishedAt = null,
  scrapedAt = null,
} = {}) {
  analysis = analysis && typeof analysis === "object" ? analysis : {};
  const eventDate = /^\d{4}-\d{2}-\d{2}$/.test(String(analysis.eventDate || ""))
    ? isoDay(analysis.eventDate)
    : null;
  const confidence = Number(analysis.eventDateConfidence);
  if (
    category === "warning" &&
    eventDate &&
    analysis.eventDatePrecision === "day" &&
    Number.isFinite(confidence) && confidence >= 0.8
  ) {
    return { eventDate, precision: "day", source: "ai" };
  }

  const publicationDay = isoDay(publishedAt);
  if (publicationDay) {
    return { eventDate: publicationDay, precision: "approximate", source: "publication" };
  }

  const firstSeenDay = isoDay(scrapedAt);
  return firstSeenDay
    ? { eventDate: firstSeenDay, precision: "approximate", source: "scrape" }
    : null;
}

const GENERIC_INCIDENT_TOKENS = new Set([
  "aktualne", "dalsi", "dalsia", "dalsie", "hnedy", "medved", "medvedi",
  "mimoriadne", "slovensko", "slovensku", "sprava", "tento", "tuto",
  "varovanie", "velky", "vyskyt",
]);

const SEMANTIC_ROOTS = Object.freeze([
  [/^cyklist/, "cyklista"],
  [/^turist/, "turista"],
  [/^polovn/, "polovnik"],
  [/^diet|^chlapc|^dievcat/, "dieta"],
  [/^utoc|^utok/, "utok"],
  [/^napad/, "napadnutie"],
  [/^(?:do|po)hryz/, "pohryzenie"],
  [/^strh/, "strhnutie"],
  [/^zran/, "zranenie"],
  [/^polytraum/, "polytrauma"],
  [/^nemocnic/, "nemocnica"],
  [/^dialnic/, "dialnica"],
  [/^zjazd/, "zjazd"],
  [/^zraz/, "zrazka"],
  [/^vozidl/, "vozidlo"],
  [/^autom?$/, "auto"],
  [/^mlad/, "mlada"],
  [/^nahan/, "nahananie"],
  [/^pohyb/, "pohyb"],
  [/^spozor|^pozorovan|^zaznamen|^objavil|^videl/, "pozorovanie"],
  [/^usmrt|^zastrel|^zabil/, "usmrtenie"],
  [/^vrtulnik/, "vrtulnik"],
  [/^zasahov/, "zasahovy"],
  [/^monitor/, "monitorovanie"],
]);

function semanticToken(token) {
  if (/^\d+$/.test(token)) return token;
  for (const [pattern, root] of SEMANTIC_ROOTS) {
    if (pattern.test(token)) return root;
  }
  if (GENERIC_INCIDENT_TOKENS.has(token)) return null;
  return token.length >= 8 ? token.slice(0, 7) : token;
}

function semanticTokens(value) {
  return new Set(
    [...textTokens(value)]
      .map(semanticToken)
      .filter(Boolean)
  );
}

function tokenSimilarity(a, b) {
  const first = semanticTokens(a);
  const second = semanticTokens(b);
  if (!first.size || !second.size) return 0;
  let overlap = 0;
  for (const token of first) if (second.has(token)) overlap += 1;
  if (!overlap) return 0;
  const cosine = overlap / Math.sqrt(first.size * second.size);
  const containment = overlap / Math.min(first.size, second.size);
  return cosine * 0.65 + containment * 0.35;
}

function eventMarkers(value) {
  const text = normalizeIncidentText(value);
  const markers = new Set();
  const add = (marker, pattern) => {
    if (pattern.test(text)) markers.add(marker);
  };

  add("victim:cyclist", /\bcyklist/);
  add("victim:hunter", /\bpolovn/);
  add("victim:tourist", /\bturist/);
  add("victim:child", /\b(?:diet|chlapc|dievcat)/);
  add("place:highway", /\b(?:dialnic|zjazd|d1)\b/);
  add("event:collision", /\b(?:zrazk|zraz)\b.{0,45}\b(?:auto|vozidl|medved)|\b(?:auto|vozidl)\b.{0,45}\b(?:zrazk|zraz)\b/);
  add("event:attack", /\b(?:utoc|utok|napad|dohryz|pohryz|strh|polytraum|zran|poranen|nemocnic|hospital)/);
  add("event:chase", /\bnahan/);
  add("event:sighting", /\b(?:vyskyt|pohyb|spozor|pozorovan|zaznamen|objavil|videl|potul)/);
  add("animal:cubs", /\b(?:mlada|mladat|mladatami)\b/);
  add("outcome:killed", /\b(?:usmrt|zastrel|zabil)/);
  add("response:helicopter", /\bvrtulnik/);

  for (const match of text.matchAll(/\b(\d{1,2})\s*(?:roc|rocn)/g)) {
    const age = Number(match[1]);
    if (age >= 3 && age <= 99) markers.add(`age:${age}`);
  }
  return markers;
}

function markerCategory(marker) {
  return String(marker).split(":", 1)[0];
}

function compareEventMarkers(a, b) {
  const first = eventMarkers(a);
  const second = eventMarkers(b);
  const overlap = [...first].filter((marker) => second.has(marker));
  const conflicts = [];
  for (const category of ["age"]) {
    const left = [...first].filter((marker) => markerCategory(marker) === category);
    const right = [...second].filter((marker) => markerCategory(marker) === category);
    if (left.length && right.length && !left.some((marker) => right.includes(marker))) {
      conflicts.push(category);
    }
  }
  const firstTypes = [...first].filter((marker) => marker.startsWith("event:"));
  const secondTypes = [...second].filter((marker) => marker.startsWith("event:"));
  const eventTypeOverlap = firstTypes.filter((marker) => secondTypes.includes(marker));
  return { overlap, conflicts, eventTypeOverlap };
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

  const criteriaText = [criteria.title, criteria.summary, criteria.query].filter(Boolean).join(" ");
  const incidentText = [incident.title, incident.summary, incident.coverage_text, incident.coverageText]
    .filter(Boolean)
    .join(" ");
  const similarity = tokenSimilarity(criteriaText, incidentText);
  const markerComparison = compareEventMarkers(criteriaText, incidentText);
  if (similarity >= 0.08) {
    score += Math.round(Math.min(similarity, 1) * 25);
    reasons.push("podobný obsah");
  }

  if (markerComparison.eventTypeOverlap.length) {
    score += 8;
    reasons.push("rovnaký typ udalosti");
  }
  if (markerComparison.overlap.length) {
    score += Math.min(24, markerComparison.overlap.length * 8);
    reasons.push("zhodné charakteristické údaje");
  }
  if (markerComparison.conflicts.length) {
    score -= markerComparison.conflicts.length * 25;
    reasons.push("rozporné charakteristické údaje");
  }

  return {
    score,
    reasons,
    dateDistanceDays: days,
    distanceKm,
    similarity,
    markerOverlap: markerComparison.overlap,
    markerConflicts: markerComparison.conflicts,
    eventTypeOverlap: markerComparison.eventTypeOverlap,
  };
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

function automaticMatchTier(incident, criteria = {}) {
  const locality = normalizeIncidentText(criteria.locality || criteria.place);
  const candidateLocality = normalizeIncidentText(incident.locality);
  const match = incident.match || scoreIncidentMatch(incident, criteria);
  const sameLocality = Boolean(locality && candidateLocality && locality === candidateLocality);
  const relatedLocality = Boolean(
    locality && candidateLocality &&
    (locality.includes(candidateLocality) || candidateLocality.includes(locality))
  );
  const samePoint = match.distanceKm !== null && match.distanceKm <= 2;
  const nearby = match.distanceKm !== null && match.distanceKm <= 20;
  const days = match.dateDistanceDays;
  const noConflicts = !match.markerConflicts?.length;
  const markerOverlap = match.markerOverlap || [];
  const identityMarkers = markerOverlap.filter((marker) => !marker.startsWith("event:"));
  const strongContentAgreement =
    match.similarity >= 0.32 ||
    (identityMarkers.length >= 1 && match.similarity >= 0.1) ||
    (markerOverlap.length >= 2 && match.similarity >= 0.1);
  const samePlaceContentAgreement = strongContentAgreement || match.similarity >= 0.18;
  const hasCriteriaContent = Boolean(
    normalizeIncidentText([criteria.title, criteria.summary, criteria.query].filter(Boolean).join(" "))
  );

  if (
    noConflicts && match.score >= 85 && days === 0 &&
    (sameLocality || relatedLocality || samePoint) &&
    (!hasCriteriaContent || strongContentAgreement)
  ) return 3;

  if (
    noConflicts && days !== null && days <= 1 && samePlaceContentAgreement && match.score >= 76 &&
    (sameLocality || relatedLocality || samePoint)
  ) return 2;

  if (
    noConflicts && days !== null && days <= 1 && nearby &&
    identityMarkers.length >= 1 && markerOverlap.length >= 2 &&
    match.similarity >= 0.16 && match.score >= 50
  ) return 1;

  return 0;
}

/**
 * Return the unique incident that best explains an article. Exact date/place
 * still wins, but a publication-date fallback and nearby locality are accepted
 * when the event type and distinctive facts agree. This handles common media
 * variants such as Turany/Sučany without merging a cyclist attack with a
 * different victim on the same weekend.
 */
export function decideAutomaticIncidentMatch(suggestions = [], criteria = {}) {
  const eligible = (suggestions || [])
    .map((incident) => ({
      ...incident,
      match: incident.match || scoreIncidentMatch(incident, criteria),
    }))
    .map((incident) => ({ ...incident, automaticTier: automaticMatchTier(incident, criteria) }))
    .filter((incident) => incident.automaticTier > 0)
    .sort((a, b) =>
      b.automaticTier - a.automaticTier ||
      b.match.score - a.match.score ||
      String(b.event_date).localeCompare(String(a.event_date))
    );

  if (!eligible.length) return { match: null, ambiguous: false, candidates: [] };
  const first = eligible[0];
  const second = eligible[1];
  const scoreGap = second ? first.match.score - second.match.score : Infinity;
  const firstMarkers = first.match.markerOverlap?.length || 0;
  const secondMarkers = second?.match?.markerOverlap?.length || 0;
  const markerAdvantage = firstMarkers > secondMarkers;
  const firstDistance = first.match.distanceKm;
  const secondDistance = second?.match?.distanceKm;
  const distanceAdvantage =
    firstDistance !== null && secondDistance !== null &&
    firstDistance <= 10 && secondDistance - firstDistance >= 8;
  const ambiguous = Boolean(
    second && first.automaticTier === second.automaticTier &&
    scoreGap < 12 && !markerAdvantage && !distanceAdvantage
  );
  return { match: ambiguous ? null : first, ambiguous, candidates: eligible };
}

export function selectAutomaticIncidentMatch(suggestions = [], criteria = {}) {
  return decideAutomaticIncidentMatch(suggestions, criteria).match;
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

function comparableSummaryText(value) {
  return normalizeIncidentText(value).replace(/\b(?:tasr|novy cas|topky|zoznam)\b/g, "").trim();
}

export function isSubstantiveIncidentSummary(value, title = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  // A headline-sized sentence is not a summary. New AI summaries are asked to
  // land between 180 and 420 characters; the lower guard still leaves room
  // for concise factual notices while rejecting empty editorial paraphrases.
  if (text.length < 140 || text.split(" ").length < 20) return false;
  if (/^(?:sprava|clanok)\s+(?:informuje|sa venuje)|podrobnosti su dostupne/i.test(normalizeIncidentText(text))) {
    return false;
  }
  const normalized = comparableSummaryText(text);
  const normalizedTitle = comparableSummaryText(title);
  if (normalizedTitle && (
    normalized === normalizedTitle ||
    (normalized.startsWith(normalizedTitle) && normalized.split(" ").length - normalizedTitle.split(" ").length <= 4)
  )) return false;
  return true;
}

function summaryCandidateScore({ text, title, generatedByAi, official, locationCount, canonical, incidentScoped }) {
  if (!isSubstantiveIncidentSummary(text, title)) return -Infinity;
  let score = Math.min(String(text).length, 520) / 5;
  if (generatedByAi) score += 35;
  if (official) score += 12;
  if (canonical) score += 10;
  // A substantive incident summary has already been scoped to the event.
  // Article summaries may mention other incidents as weekend context even
  // when they come from the canonical source article.
  if (incidentScoped) score += 45;
  if (locationCount > 1) score -= 45;
  if (/\d/.test(text)) score += 8;
  if (/[.!?]\s+\S/.test(text)) score += 8;
  if (/…|\.\.\.$/.test(String(text).trim())) score -= 35;
  return score;
}

export function selectIncidentSummary({ incident = {}, entries = [], primary = {} } = {}) {
  const candidates = [];
  candidates.push({
    text: incident.summary,
    title: incident.title,
    generatedByAi: false,
    official: incident.verification_status === "official_notice",
    locationCount: 1,
    canonical: true,
    incidentScoped: true,
  });

  for (const { article, link } of entries) {
    candidates.push({
      text: article.summary,
      title: article.title,
      generatedByAi: Boolean(article.summaryGeneratedByAi),
      official: link?.source_type === "official_notice",
      locationCount: normalizeNewsLocations(article.locations).length || 1,
      canonical: String(article.id) === String(incident.primary_news_id),
      incidentScoped: false,
    });
  }

  const selected = candidates
    .map((candidate) => ({
      ...candidate,
      score: summaryCandidateScore(candidate),
    }))
    .sort((a, b) => b.score - a.score)[0];

  if (selected && Number.isFinite(selected.score)) {
    return {
      text: String(selected.text).replace(/\s+/g, " ").trim().slice(0, 520),
      generatedByAi: selected.generatedByAi,
    };
  }

  const fallback = primary.summary || primary.snippet || incident.summary || incident.title || "";
  return { text: String(fallback).replace(/\s+/g, " ").trim().slice(0, 520), generatedByAi: false };
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
    const locations = normalizeNewsLocations({
      place: incident.locality || primary.place,
      lat: incident.lat ?? primary.lat,
      lng: incident.lng ?? primary.lng,
    });
    const primaryLocation = locations[0] || null;
    const selectedSummary = selectIncidentSummary({ incident, entries, primary });

    grouped.push({
      id: `incident-${incidentId}`,
      incidentId,
      isIncident: true,
      title: incident.title,
      snippet: selectedSummary.text,
      summary: selectedSummary.text,
      summaryGeneratedByAi: selectedSummary.generatedByAi,
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
