const DEDUPE_TIME_BUCKET_MS = 60 * 1000;

function normalizeText(value) {
  return String(value || "")
    .toLocaleLowerCase("sk-SK")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function timeBucket(value) {
  if (!value) return "";
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "";
  return new Date(Math.floor(time / DEDUPE_TIME_BUCKET_MS) * DEDUPE_TIME_BUCKET_MS).toISOString();
}

function coordBucket(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(5) : "";
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

export function dedupeSightings(items) {
  const seenIds = new Set();
  const seenContent = new Set();
  const unique = [];

  for (const item of items || []) {
    if (!item) continue;

    const id = item.id ? String(item.id) : "";
    if (id && seenIds.has(id)) continue;
    if (id) seenIds.add(id);

    const contentKey = sightingDedupeKey(item);
    if (contentKey && seenContent.has(contentKey)) continue;
    if (contentKey) seenContent.add(contentKey);

    unique.push(item);
  }

  return unique;
}
