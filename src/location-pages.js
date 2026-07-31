function recordIdentity(item, type) {
  const stableId =
    item?.id ||
    item?.incidentId ||
    item?.articleUrl ||
    item?.link ||
    item?.googleNewsUrl;
  if (stableId) return `${type}:${stableId}`;

  const label = item?.title || item?.location || item?.place || "record";
  const date = item?.reportedAt || item?.date || "undated";
  return `${type}:${label}:${date}`;
}

function uniqueRecords(items, type) {
  const seen = new Set();
  return items.filter((item) => {
    const key = recordIdentity(item, type);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validDateEntries(values) {
  return values
    .filter(Boolean)
    .map((value) => ({ value, time: new Date(value).getTime() }))
    .filter((entry) => Number.isFinite(entry.time));
}

function dateBounds(location) {
  const entries = validDateEntries([
    location.latest,
    location.first,
    ...location.warningItems.map((item) => item.reportedAt),
    ...location.newsItems.map((item) => item.date),
  ]).sort((a, b) => a.time - b.time);
  return {
    first: entries[0]?.value || null,
    latest: entries.at(-1)?.value || null,
  };
}

function nameQuality(value) {
  const text = String(value || "");
  const diacritics = (text.normalize("NFD").match(/[\u0300-\u036f]/g) || []).length;
  return diacritics * 100 + text.length;
}

/**
 * Zlúči lokality, ktoré majú po normalizácii rovnaký slug (napr. Podbanské a
 * Podbanske). Sitemap tak nikdy neobsahuje tú istú kanonickú URL dvakrát.
 */
export function mergeLocationPages(candidates) {
  const bySlug = new Map();

  for (const candidate of candidates) {
    if (!candidate?.slug) continue;
    const existing = bySlug.get(candidate.slug);
    if (!existing) {
      bySlug.set(candidate.slug, {
        ...candidate,
        warningItems: [...candidate.warningItems],
        newsItems: [...candidate.newsItems],
      });
      continue;
    }

    existing.warningItems.push(...candidate.warningItems);
    existing.newsItems.push(...candidate.newsItems);
    if (existing.lat == null && candidate.lat != null) {
      existing.lat = candidate.lat;
      existing.lng = candidate.lng;
    }
    if (nameQuality(candidate.name) > nameQuality(existing.name)) {
      existing.name = candidate.name;
    }
    existing.latest = dateBounds({
      ...existing,
      latest: candidate.latest,
      first: candidate.first,
    }).latest;
  }

  return [...bySlug.values()]
    .map((location) => {
      const warningItems = uniqueRecords(location.warningItems, "warning");
      const newsItems = uniqueRecords(location.newsItems, "news");
      const bounds = dateBounds({ ...location, warningItems, newsItems });
      return {
        ...location,
        warningItems,
        newsItems,
        sightings: warningItems.length,
        news: newsItems.length,
        total: warningItems.length + newsItems.length,
        first: bounds.first,
        latest: bounds.latest,
      };
    })
    .sort(
      (a, b) =>
        b.total - a.total ||
        b.sightings - a.sightings ||
        a.name.localeCompare(b.name, "sk")
    );
}
