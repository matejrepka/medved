import test from "node:test";
import assert from "node:assert/strict";

import { decodeHtmlEntities, htmlToText } from "../src/html-text.js";

test("dekóduje číselnú HTML entitu trojbodky z WordPress excerptu", () => {
  assert.equal(decodeHtmlEntities("Zásahový tím ŠOP&#8230;"), "Zásahový tím ŠOP…");
});

test("vyčistí HTML a dekóduje aj viacnásobne zakódovanú entitu", () => {
  assert.equal(
    htmlToText("<p>Štátna ochrana prírody&nbsp;SR&amp;#8230;</p>"),
    "Štátna ochrana prírody SR…"
  );
});
