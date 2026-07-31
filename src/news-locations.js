const DEFAULT_MAX_LOCATIONS = 12;

function cleanPlace(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 160);
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeLocationName(value) {
  return cleanPlace(value)
    .toLocaleLowerCase("sk")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizeNewsLocations(value, { max = DEFAULT_MAX_LOCATIONS } = {}) {
  const input = Array.isArray(value) ? value : value ? [value] : [];
  const byName = new Map();

  for (const entry of input) {
    const object = typeof entry === "string" ? { place: entry } : entry || {};
    const place = cleanPlace(object.place || object.name || object.label);
    const key = normalizeLocationName(place);
    if (!key) continue;

    const lat = nullableNumber(object.lat);
    const lng = nullableNumber(object.lng);
    const location = {
      place,
      lat,
      lng,
      hasCoords: lat !== null && lng !== null,
    };

    const existing = byName.get(key);
    if (!existing) byName.set(key, location);
    else if (!existing.hasCoords && location.hasCoords) {
      byName.set(key, { ...location, place: existing.place });
    }
    if (byName.size >= max) break;
  }

  return [...byName.values()];
}

export function legacyNewsLocation(item = {}) {
  return normalizeNewsLocations({
    place: item.place,
    lat: item.lat,
    lng: item.lng,
  })[0] || null;
}

export function newsLocations(item = {}) {
  const locations = normalizeNewsLocations(item.locations);
  if (locations.length) return locations;
  const legacy = legacyNewsLocation(item);
  return legacy ? [legacy] : [];
}

export function mergeNewsLocations(items, options) {
  return normalizeNewsLocations(
    (items || []).flatMap((item) => newsLocations(item)),
    options
  );
}
