const PUBLIC_API = new Set(["/api/news", "/api/warnings", "/api/stats"]);
const PUBLIC_PAGES = new Set(["/", "/domov", "/spravy", "/varovania", "/stats"]);
const ARCHIVE_PARAMETERS = new Set(["q", "strana", "pocet"]);
const RECORD_PAGE = /^\/(?:varovania|spravy)\/[a-z0-9-]+-[a-f0-9]{10}$/;

export function publicCacheUrl(request, version) {
  if (request.method !== "GET" || request.headers.has("authorization") ||
      request.headers.has("cookie") || request.headers.has("range")) return null;
  const url = new URL(request.url);
  if (url.pathname.length > 300 || url.search.length > 300) return null;
  const api = PUBLIC_API.has(url.pathname);
  const page = PUBLIC_PAGES.has(url.pathname) || /^\/vyskyt-medveda\/[a-z0-9-]+$/.test(url.pathname) ||
    RECORD_PAGE.test(url.pathname);
  if (!api && !page) return null;
  for (const key of url.searchParams.keys()) {
    if (api ? key !== "v" : !(["/spravy", "/varovania"].includes(url.pathname) && ARCHIVE_PARAMETERS.has(key))) return null;
  }
  url.searchParams.sort();
  url.searchParams.set("__medved_cache", `public-v14:${version}`);
  return url.href;
}

export function publicCacheTtl(request) {
  // Revision metadata is checked before every lookup, so edited/removed records
  // retire within 15 seconds even with a longer edge TTL. Cap detail HTML at an
  // hour because the related cards also contain time-dependent age labels.
  return RECORD_PAGE.test(new URL(request.url).pathname) ? 3600 : 60;
}

export function clientCacheResponse(response, status) {
  const result = new Response(response.body, response);
  // Revision metadata is rechecked every 15 seconds. Keep browser caching
  // equally short so it cannot prolong a retired revision for several minutes.
  result.headers.set("Cache-Control", "public, max-age=15");
  result.headers.set("X-Medved-Cache", status);
  return result;
}

export function canStorePublicResponse(response) {
  return response.status === 200 && !response.headers.has("set-cookie") &&
    /\bpublic\b/i.test(response.headers.get("cache-control") || "") &&
    !/\b(?:private|no-store)\b/i.test(response.headers.get("cache-control") || "") &&
    response.headers.get("vary") !== "*";
}
