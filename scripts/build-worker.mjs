import { build } from "esbuild";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist-worker");
const assets = path.join(output, "public");
await mkdir(assets, { recursive: true });
await cp(path.join(root, "public"), assets, { recursive: true });

// Copy only browser packages to the public assets binding. No environment,
// database credentials or backend source files are included.
const vendors = {
  leaflet: "leaflet/dist",
  "phosphor/regular": "@phosphor-icons/web/src/regular",
  chart: "chart.js/dist",
  "fonts/hanken": "@fontsource-variable/hanken-grotesk",
  "fonts/newsreader": "@fontsource-variable/newsreader",
  analytics: "@vercel/analytics/dist",
};
for (const [destination, source] of Object.entries(vendors)) {
  await cp(path.join(root, "node_modules", source), path.join(assets, "vendor", destination), { recursive: true });
}
const iconPath = "node_modules/@phosphor-icons/web/src/regular/style.css";
const iconCss = (await readFile(path.join(root, iconPath), "utf8")).replace("font-display: block;", "font-display: swap;");
await writeFile(path.join(assets, "vendor/phosphor/regular/style.css"), iconCss);

// Templates and the offline gazetteer are private module data, not files in
// Workers' virtual filesystem. This preserves SSR and location search.
const resources = {};
for (const filename of await readdir(path.join(root, "public"))) {
  if (filename.endsWith(".html")) resources[`/app/public/${filename}`] = await readFile(path.join(root, "public", filename), "utf8");
}
resources["/app/src/geo/sk-places.json"] = await readFile(path.join(root, "src/geo/sk-places.json"), "utf8");
resources[`/app/${iconPath}`] = iconCss;

await build({
  absWorkingDir: root,
  entryPoints: ["workers/index.js"],
  outfile: path.join(output, "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  minify: true,
  // CommonJS dependencies still require Node built-ins at runtime.
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire("/bundle/index.js");' },
  external: ["cloudflare:node", "cloudflare:workers", "node:*"],
  alias: { "#platform": "./workers/platform.js" },
  plugins: [{
    name: "worker-resources",
    setup(plugin) {
      plugin.onResolve({ filter: /^#worker-resources$/ }, () => ({ path: "resources", namespace: "resources" }));
      plugin.onLoad({ filter: /.*/, namespace: "resources" }, () => ({ contents: `export default ${JSON.stringify(resources)};`, loader: "js" }));
      // Chromium belongs to the existing Node/GitHub scraper, never this bundle.
      plugin.onResolve({ filter: /browser-fetch\.js$/ }, () => ({ path: path.join(root, "workers/browser-fetch.js") }));
      // Workers supplies process.env from runtime bindings; dotenv must not read
      // a developer's local .env during the build or runtime initialization.
      plugin.onResolve({ filter: /^dotenv\/config$/ }, () => ({ path: "dotenv", namespace: "empty" }));
      plugin.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "", loader: "js" }));
    },
  }],
});
console.log("Workers API, HTML templates and browser assets built in dist-worker/");
