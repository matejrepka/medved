import assert from "node:assert/strict";
import test from "node:test";

import { buildTelegramCard } from "../src/telegram/cards.js";

const config = { siteOrigin: "https://example.test" };

test("AI warning news produces one moderation card with one action row", () => {
  const card = buildTelegramCard({
    id: 7,
    event_type: "imported_news",
    aggregate_type: "news_log",
    payload: {
      category: "warning",
      title: "Medveď pri <obci>",
      source: "Médium",
      published_at: "2026-07-31T08:00:00Z",
      created_at: "2026-07-31T10:00:00Z",
      place: "Liptov",
      snippet: "Obec upozorňuje obyvateľov.",
      link: "https://news.example/item",
    },
  }, config);

  assert.match(card.text, /AI štítok:<\/b> medvedie varovanie/);
  assert.match(card.text, /Medveď pri &lt;obci&gt;/);
  assert.match(card.text, /Publikované:/);
  assert.match(card.text, /Importované:/);
  assert.equal(card.reply_markup.inline_keyboard.length, 1);
  assert.deepEqual(
    card.reply_markup.inline_keyboard[0].map((button) => button.callback_data),
    ["tm:a:7", "tm:r:7"]
  );
});

test("scraper warning card keeps merged source identities and timestamps", () => {
  const card = buildTelegramCard({
    id: 8,
    event_type: "scraper_warning",
    aggregate_type: "tumedved_log",
    payload: {
      location: "Donovaly",
      note: "Pozorovanie pri lese",
      reported_at: "2026-07-31T06:00:00Z",
      scraped_at: "2026-07-31T07:00:00Z",
      payload: {
        sourceLinks: [
          { label: "tumedved.sk", url: "https://tumedved.sk/item" },
          { label: "mapamedvedov.sk", url: "https://mapamedvedov.sk/item" },
        ],
      },
    },
  }, config);

  assert.match(card.text, /tumedved\.sk/);
  assert.match(card.text, /mapamedvedov\.sk/);
  assert.match(card.text, /Importované:/);
  assert.equal(card.reply_markup, undefined);
});

test("admin warning cards distinguish supported manual item types", () => {
  const news = buildTelegramCard({
    id: 9,
    event_type: "admin_warning",
    aggregate_type: "news_log",
    payload: { title: "Výstraha", place: "Zvolen", published_at: "2026-07-31T10:00:00Z" },
  }, config);
  const tumedved = buildTelegramCard({
    id: 10,
    event_type: "admin_warning",
    aggregate_type: "tumedved_log",
    payload: { location: "Detva", reported_at: "2026-07-31T10:00:00Z" },
  }, config);
  assert.match(news.text, /varovanie zo správ/);
  assert.match(tumedved.text, /tumedved/);
});

test("card size limiting keeps complete HTML lines", () => {
  const card = buildTelegramCard({
    id: 11,
    event_type: "imported_news",
    aggregate_type: "news_log",
    payload: {
      category: "article",
      title: "T".repeat(5000),
      source: "S".repeat(5000),
      snippet: "<unsafe>".repeat(1000),
      published_at: "2026-07-31T10:00:00Z",
      link: `https://example.test/${"x".repeat(1000)}`,
    },
  }, config);
  assert.ok(card.text.length <= 3900);
  assert.equal((card.text.match(/<b>/g) || []).length, (card.text.match(/<\/b>/g) || []).length);
  assert.equal((card.text.match(/<a /g) || []).length, (card.text.match(/<\/a>/g) || []).length);
});
