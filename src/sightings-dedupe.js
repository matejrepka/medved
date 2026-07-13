const DEDUPE_TIME_BUCKET_MS = 60 * 1000;
const MAX_CLOSE_DISTANCE_KM = 2.5;
const MAX_POSSIBLE_DISTANCE_KM = 5;

const SOURCE_PRIORITY = {
  report: 40,
  tumedved: 30,
  mapamedvedov: 20,
  sprejnamedveda: 10,
};

const NOTE_STOP_WORDS = new Set([
  "a", "aj", "ale", "bol", "bola", "bolo", "boli", "cez", "do", "dna", "ho",
  "je", "k", "ktory", "medved", "medveda", "medvede", "medvedom", "na", "nad",
  "od", "okoli", "po", "pod", "pri", "sa", "sme", "s", "tu", "v", "vo", "z",
  "za", "zaznamenany", "zaznamenana", "zaznamenane", "vyskyt", "hlasenie", "hlaseny",
  "lokalite", "lokalita", "verejnej", "mapy", "zdroj", "rucnu", "kontrolu", "overit",
  "datum", "presnu", "polohu", "povahu", "udalosti", "pred", "vlozenim", "wordpress",
]);

function normalizeText(value) {
  return String(value || "")
    .toLocaleLowerCase("sk-SK")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function tokens(value, { note = false } = {}) {
  const result = normalizeText(value).split(" ").filter(Boolean);
  return note ? result.filter((token) => token.length > 2 && !NOTE_STOP_WORDS.has(token)) : result;
}

function jaccard(a, b) {
  const left = new Set(a);
  const right = new Set(b);
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function timeBucket(value) {
  if (!value) return "";
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "";
  return new Date(Math.floor(time / DEDUPE_TIME_BUCKET_MS) * DEDUPE_TIME_BUCKET_MS).toISOString();
}

function localDateKey(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Bratislava",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return [get("year"), get("month"), get("day")].join("-");
}

function coordBucket(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(5) : "";
}

function validCoords(item) {
  const lat = Number(item?.lat);
  const lng = Number(item?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

function distanceKm(a, b) {
  const left = validCoords(a);
  const right = validCoords(b);
  if (!left || !right) return null;

  const rad = Math.PI / 180;
  const dLat = (right.lat - left.lat) * rad;
  const dLng = (right.lng - left.lng) * rad;
  const lat1 = left.lat * rad;
  const lat2 = right.lat * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function sourceKey(item) {
  if (item?.sourceKey) return String(item.sourceKey);
  const source = normalizeText(item?.source);
  if (source.includes("tumedved")) return "tumedved";
  if (source.includes("mapamedvedov")) return "mapamedvedov";
  if (source.includes("sprejnamedveda")) return "sprejnamedveda";
  if (item?.sourceType === "report") return "report";
  return source || "unknown";
}

function sourcePriority(item) {
  return SOURCE_PRIORITY[sourceKey(item)] || 0;
}

function normalizeSourceLink(link) {
  if (!link || typeof link !== "object") return null;
  const url = String(link.url || "").trim();
  if (!url) return null;
  const key = String(link.key || "source").trim() || "source";
  let label = String(link.label || link.key || "Zdroj").trim() || "Zdroj";
  if (key === "sprejnamedveda") {
    if (/\/aktuality\//i.test(url)) label = "sprejnamedveda.sk – článok";
    else if (/sprejnamedveda\.sk\/medvede-na-mape\/?/i.test(url)) {
      label = "sprejnamedveda.sk – mapa";
    }
  }
  return {
    key,
    label,
    url,
    ...(link.sourceId ? { sourceId: String(link.sourceId) } : {}),
  };
}

export function sightingSourceLinks(item) {
  const links = (Array.isArray(item?.sourceLinks) ? item.sourceLinks : [])
    .map(normalizeSourceLink)
    .filter(Boolean);

  if (item?.url) {
    links.push({
      key: sourceKey(item),
      label: String(item.source || "Zdroj"),
      url: String(item.url),
      ...(item.id ? { sourceId: String(item.id) } : {}),
    });
  }

  const seen = new Set();
  return links.filter((link) => {
    const key = `${link.key}|${link.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function sightingDedupeKey(item) {
  if (!item) return "";

  const location = normalizeText(item.location);
  const note = normalizeText(item.note);
  const reportedAt = timeBucket(item.reportedAt);
  const lat = coordBucket(item.lat);
  const lng = coordBucket(item.lng);

  if (!location && !note && !reportedAt && !lat && !lng) return "";
  return [location, note, reportedAt, lat, lng].join("|");
}

function notesAreGeneric(a, b) {
  const left = tokens(a?.note, { note: true });
  const right = tokens(b?.note, { note: true });
  return left.length <= 2 || right.length <= 2;
}

function hasPreciseTime(item) {
  return item?.datePrecision !== "date" && /T\d{2}:\d{2}/.test(String(item?.reportedAt || ""));
}

export function areSimilarSightings(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id && String(a.id) === String(b.id)) return true;

  const exactA = sightingDedupeKey(a);
  const exactB = sightingDedupeKey(b);
  if (exactA && exactA === exactB) return true;

  const linkIdentity = (link) => link.sourceId
    ? `${link.key}|id:${link.sourceId}`
    : `${link.key}|url:${link.url}`;
  const linksA = new Set(sightingSourceLinks(a).map(linkIdentity));
  if (sightingSourceLinks(b).some((link) => linksA.has(linkIdentity(link)))) return true;

  const dateA = localDateKey(a.reportedAt);
  const dateB = localDateKey(b.reportedAt);
  if (!dateA || dateA !== dateB) return false;

  if (hasPreciseTime(a) && hasPreciseTime(b)) {
    const timeDifference = Math.abs(new Date(a.reportedAt) - new Date(b.reportedAt));
    if (!Number.isFinite(timeDifference) || timeDifference > 6 * 60 * 60 * 1000) return false;
  }

  const locationA = normalizeText(a.location);
  const locationB = normalizeText(b.location);
  const locationScore = jaccard(tokens(locationA), tokens(locationB));
  const locationExact = Boolean(locationA && locationA === locationB);
  const distance = distanceKm(a, b);
  const closeCoordinates = distance !== null && distance <= MAX_CLOSE_DISTANCE_KM;
  const possibleCoordinates = distance !== null && distance <= MAX_POSSIBLE_DISTANCE_KM;
  const strongLocation = locationExact || locationScore >= 0.66 || closeCoordinates;
  const possibleLocation = strongLocation || locationScore >= 0.4 || possibleCoordinates;
  if (!possibleLocation) return false;

  const noteScore = jaccard(tokens(a.note, { note: true }), tokens(b.note, { note: true }));
  const differentSources = sourceKey(a) !== sourceKey(b);

  // V rámci jedného zdroja zlučujeme iba prakticky totožné položky. Rovnaká obec
  // a deň môžu obsahovať viac samostatných pozorovaní.
  if (!differentSources) {
    return strongLocation && closeCoordinates && noteScore >= 0.55;
  }

  if (strongLocation && closeCoordinates) return true;
  if (strongLocation && noteScore >= 0.25) return true;
  if (locationExact && notesAreGeneric(a, b)) return true;
  return possibleLocation && possibleCoordinates && noteScore >= 0.15;
}

function preferredItem(items) {
  return [...items].sort((a, b) => {
    const priority = sourcePriority(b) - sourcePriority(a);
    if (priority) return priority;
    const precise = Number(hasPreciseTime(b)) - Number(hasPreciseTime(a));
    if (precise) return precise;
    return String(b.note || "").length - String(a.note || "").length;
  })[0];
}

function mergeCluster(items) {
  const primary = preferredItem(items);
  const coordinates = validCoords(primary) || items.map(validCoords).find(Boolean);
  const preciseDate = items.find(hasPreciseTime);
  const note = primary.note || items.map((item) => item.note).find(Boolean) || "";
  const sourceLinks = items.flatMap(sightingSourceLinks);
  const merged = {
    ...primary,
    note,
    reportedAt: preciseDate?.reportedAt || primary.reportedAt,
    datePrecision: preciseDate ? preciseDate.datePrecision || "datetime" : primary.datePrecision,
    lat: coordinates?.lat ?? null,
    lng: coordinates?.lng ?? null,
    hasCoords: Boolean(coordinates),
    sourceLinks,
  };

  merged.sourceLinks = sightingSourceLinks(merged);
  merged.url = merged.sourceLinks.find((link) => link.key === sourceKey(primary))?.url
    || merged.sourceLinks[0]?.url
    || primary.url
    || null;
  merged.mergedSourceCount = new Set(merged.sourceLinks.map((link) => link.key)).size;
  return merged;
}

export function dedupeSightings(items) {
  const clustersByDate = new Map();
  const undated = [];

  for (const item of items || []) {
    if (!item) continue;
    const key = localDateKey(item.reportedAt);
    if (!key) {
      undated.push([item]);
      continue;
    }

    const clusters = clustersByDate.get(key) || [];
    const cluster = clusters.find((candidate) =>
      candidate.some((existing) => areSimilarSightings(existing, item))
    );
    if (cluster) cluster.push(item);
    else clusters.push([item]);
    clustersByDate.set(key, clusters);
  }

  return [...clustersByDate.values(), undated]
    .flat()
    .map(mergeCluster)
    .sort((a, b) => new Date(b.reportedAt || 0) - new Date(a.reportedAt || 0));
}
