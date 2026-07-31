import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("single-source incidents do not render a redundant coverage disclosure", async () => {
  const [server, client] = await Promise.all([
    readFile(new URL("../server.js", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);

  assert.match(
    server,
    /item\.isIncident\s*&&\s*Array\.isArray\(item\.coverage\)\s*&&\s*item\.coverage\.length\s*>\s*1/
  );
  assert.match(
    client,
    /n\.isIncident\s*&&\s*Array\.isArray\(n\.coverage\)\s*&&\s*n\.coverage\.length\s*>\s*1/
  );
});

test("listings omit explanatory one-liners and expose mobile source links", async () => {
  const [server, client, styles] = await Promise.all([
    readFile(new URL("../server.js", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(server, /<p class="record-explanation">/);
  assert.doesNotMatch(client, /<p class="record-explanation">/);
  assert.match(server, /meta-source-links-mobile/);
  assert.match(client, /meta-source-links-mobile/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*?\.mobile-source-duplicate\s*\{\s*display:\s*none;/);
});
