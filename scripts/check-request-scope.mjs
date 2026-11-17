import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const { outputFiles } = await build({
  absWorkingDir: root, write: false, bundle: true, platform: "node", format: "esm",
  external: ["cloudflare:*", "node:*"], alias: { "#platform": "./workers/platform.js" },
  plugins: [{ name: "empty-resources", setup(plugin) {
    plugin.onResolve({ filter: /^#worker-resources$/ }, () => ({ path: "resources", namespace: "fixture" }));
    plugin.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export default {}" }));
  } }],
  stdin: { resolveDir: root, contents: `
    import { withWorkerContext, getEnvironment, getInFlightState } from './workers/platform.js';
    import { getPublicSnapshotVersion, loadPublicSnapshot } from './src/db/public-snapshot.js';
    import { getSupabase } from './src/db/supabase.js';
    import { ScheduledDataStore } from './src/scheduled-store.js';
    const never = () => new Promise(() => {});
    const owner = {};
    let documentReads = 0;
    const client = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () =>
        getEnvironment().mode === 'metadata' ? never() :
        { data: { revision: 1, built_revision: 1, updated_at: '2026-11-14T10:00:00Z' } }
      }) }) }),
      rpc: async () => {
        documentReads++;
        return getEnvironment().mode === 'document' ? never() : { data: { items: ['ready'] } };
      },
    };
    const store = new ScheduledDataStore({ name: 'fixture', loadStored: async () =>
      getEnvironment().mode === 'store' ? never() : [{ id: 'ready' }] });
    export default {
      fetch(request, env, ctx) {
        const mode = new URL(request.url).searchParams.get('abandon');
        return withWorkerContext({ request, env: { ...env, mode }, ctx }, async () => {
          if (mode === 'metadata') void getPublicSnapshotVersion(client).catch(() => {});
          else if (mode === 'document') {
            const before = documentReads;
            void loadPublicSnapshot({ client, slug: 'abandoned' }).catch(() => {});
            while (documentReads === before) await Promise.resolve();
          } else if (mode === 'store') void store.loadFromDatabase().catch(() => {});
          else if (mode === 'owner') getInFlightState(owner).inFlight = never();
          else {
            if (getInFlightState(owner).inFlight) throw new Error('Inherited pending work');
            const result = await Promise.race([
              Promise.all([loadPublicSnapshot({ client, slug: new URL(request.url).pathname === '/document' ? 'abandoned' : null }), store.loadFromDatabase(),
                getSupabase().from('fixture').select('id')]),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Abandoned request blocked its successor')), 1000)),
            ]);
            return Response.json(result);
          }
          return new Response('Request ended with unfinished work');
        });
      },
    };
  ` },
});
const runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: outputFiles[0].text,
  compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags,
  bindings: { SUPABASE_URL: "https://fixture.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "fixture-key" },
  outboundService(request) {
    assert.equal(request.headers.get("authorization"), "Bearer fixture-key");
    assert.equal(request.headers.get("apikey"), "fixture-key");
    return Response.json([{ id: "ready" }]);
  },
}));
try {
  for (const mode of ["metadata", "document", "store", "owner"]) {
    const abandoned = await runtime.dispatchFetch(`https://fixture.test/?abandon=${mode}`);
    assert.equal(abandoned.status, 200);
    await abandoned.text();
    const next = await runtime.dispatchFetch(`https://fixture.test/${mode}`);
    assert.equal(next.status, 200, `${mode}: ${await next.clone().text()}`);
    const [snapshot, stored, query] = await next.json();
    assert.deepEqual(snapshot.items, ["ready"]);
    assert.equal(stored[0].id, "ready");
    assert.equal(query.data[0].id, "ready");
  }
  console.log("Workers checks passed: abandoned metadata, document and store loads cannot poison later requests; service queries use direct credentials");
} finally { await runtime.dispose(); }
