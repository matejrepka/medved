import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the small map icon font covers static and dynamically selected icons", async () => {
  const root = new URL("../public/", import.meta.url);
  // Only the map page uses the subset font; other pages keep the full icon stylesheet.
  const files = ["index.html", "app.js", "page.js"];
  const sources = (await Promise.all(files.map(file => readFile(new URL(file, root), "utf8")))).join("\n") + await readFile(new URL("../server.js", import.meta.url), "utf8");
  const css = await readFile(new URL("map-icons.css", root), "utf8");
  const names = new Set([...sources.matchAll(/ph-([a-z][a-z0-9-]*)/g)].map(match => match[1]));
  for (const match of sources.matchAll(/icon:\s*["']([a-z-]+)/g)) names.add(match[1]);
  for (const name of ["sun", "moon"]) names.add(name);
  for (const name of names) assert.ok(css.includes(`.ph.ph-${name}:before`), name);
  assert.ok((await readFile(new URL("map-icons.woff2", root))).length < 12000);
});
