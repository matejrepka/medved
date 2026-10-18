import { buildStatsReport } from "./stats-report.js";
import { createLocationRecordMatcher, mergeLocationPages } from "./location-pages.js";

export function normalizeSearchText(value) {
  return String(value || "").toLocaleLowerCase("sk").normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replaceAll("ľ", "l").replaceAll("ĺ", "l")
    .replaceAll("ŕ", "r").replace(/[^a-z0-9]+/g, " ").trim();
}

export function buildPublicOverview({ warnings, news, gz, updatedAt }) {
  const report = buildStatsReport({ sightings: warnings, news, gz, includeAllLocations: true });
  const matchWarnings = createLocationRecordMatcher(warnings, "warning", normalizeSearchText);
  const matchNews = createLocationRecordMatcher(news, "news", normalizeSearchText);
  const candidates = report.allLocations.map(location => {
    const warningItems = matchWarnings(location.name);
    const newsItems = matchNews(location.name);
    const latest = [...warningItems.map(item => item.reportedAt), ...newsItems.map(item => item.date)]
      .filter(Boolean).sort().pop() || updatedAt;
    const slug = normalizeSearchText(location.name).replaceAll(" ", "-");
    return { ...location, slug, path: `/vyskyt-medveda/${encodeURIComponent(slug)}`,
      warningItems, newsItems, latest };
  });
  const locations = mergeLocationPages(candidates).filter(location => location.total >= 2);
  return { report, locations, topLocations: locations.slice(0, 12), warnings, news, updatedAt };
}
