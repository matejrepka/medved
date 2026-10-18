import { httpServerHandler } from "cloudflare:node";
import app, { invalidatePublicCaches } from "../server.js";
import { withWorkerContext } from "./platform.js";
import { getPublicSnapshotVersion } from "../src/db/public-snapshot.js";
import { publicCacheUrl, clientCacheResponse, canStorePublicResponse } from "./public-cache.js";

app.listen(3000);
const handler = httpServerHandler({ port: 3000 });
let lastVersion;

export default {
  fetch(request, env, ctx) {
    // Only Cloudflare's verified client IP reaches Express's one-hop proxy
    // handling. Discard any client-supplied forwarding chain.
    const headers = new Headers(request.headers);
    headers.set("x-forwarded-for", request.headers.get("cf-connecting-ip") || "127.0.0.1");
    headers.set("x-forwarded-proto", new URL(request.url).protocol.slice(0, -1));
    const forwarded = new Request(request, { headers });
    return withWorkerContext({ request: forwarded, env, ctx }, async () => {
      let cacheRequest;
      if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY && publicCacheUrl(request, "check")) {
        try {
          const version = await getPublicSnapshotVersion();
          const identity = `${env.SUPABASE_URL}:${version}`;
          if (lastVersion !== undefined && lastVersion !== identity) invalidatePublicCaches();
          lastVersion = identity;
          if (version) {
            cacheRequest = new Request(publicCacheUrl(request, `${env.SUPABASE_URL}:${version}`), {
              headers: request.headers,
            });
            const cached = await caches.default.match(cacheRequest);
            if (cached) return clientCacheResponse(cached, "HIT");
          }
        } catch (error) {
          // A cache/metadata outage must not expose a stale private response or
          // prevent the handler from producing its normal fallback/error.
          console.error("[public-cache] lookup failed:", error.message);
          cacheRequest = null;
        }
      }
      const response = await handler.fetch(forwarded, env, ctx);
      if (request.method !== "GET" && request.method !== "HEAD" && response.ok) {
        invalidatePublicCaches();
      }
      if (cacheRequest && canStorePublicResponse(response)) {
        const stored = new Response(response.clone().body, response);
        stored.headers.set("Cache-Control", "public, max-age=60");
        ctx.waitUntil(caches.default.put(cacheRequest, stored).catch(error => {
          console.error("[public-cache] write failed:", error.message);
        }));
        return clientCacheResponse(response, "MISS");
      }
      return response;
    });
  },
};
