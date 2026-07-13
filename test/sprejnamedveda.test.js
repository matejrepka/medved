import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSprejnamedvedaArticleIndex,
  cleanSprejnamedvedaDescription,
  isRelevantSprejnamedvedaRow,
  normalizeSprejnamedvedaRow,
} from "../src/scrapers/sprejnamedveda.js";

test("odstráni redakčný obal a ponechá pôvodnú poznámku zo zdroja", () => {
  const raw = "Automaticky zachyteny kandidat z verejnej mapy na rucnu kontrolu. " +
    "Zdroj: TuMedved.sk. Odporucanie: overit datum. Cas hlasenia: 19:35. " +
    "Poznamka zo zdroja: medveď bol približne 20 m od rybníka";

  assert.equal(
    cleanSprejnamedvedaDescription(raw),
    "medveď bol približne 20 m od rybníka"
  );
  assert.equal(isRelevantSprejnamedvedaRow({ location: "Ďanová - rybník", description: raw }), true);
});

test("importovaný článok nepoužije ako komentár", () => {
  const raw = "Automaticky zachyteny kandidat na rucnu kontrolu mapy. " +
    "Zdroj: Pozor medved. Clanok: Upozornenie na výskyt medveďa v obci Hrochoť. " +
    "Odporucanie: overit v povodnom zdroji presnu lokalitu.";

  assert.equal(
    cleanSprejnamedvedaDescription(raw),
    ""
  );
});

test("prázdny draft import nezobrazuje ako komentár", () => {
  const description = "Draft import 2026. Zdroj: Pozor medved. Overit pred publikovanim.";
  assert.equal(cleanSprejnamedvedaDescription(description), "");
  assert.equal(isRelevantSprejnamedvedaRow({ location: "Liptovský Ján", description }), false);
});

test("interný import bez pôvodnej poznámky nezobrazuje ako komentár", () => {
  const description = "Automaticky zachyteny kandidat z verejnej mapy na rucnu kontrolu. " +
    "Zdroj: TuMedved.sk. Odporucanie: overit datum a presnu polohu.";
  assert.equal(cleanSprejnamedvedaDescription(description), "");
  assert.equal(isRelevantSprejnamedvedaRow({ location: "Stará Bystrica", description }), false);
});

test("bežný komentár ponechá bez zmeny", () => {
  assert.equal(
    cleanSprejnamedvedaDescription("Medvedica s mláďaťom prešla cez cestu."),
    "Medvedica s mláďaťom prešla cez cestu."
  );
});

test("neúplný zvyšok dátumu nepoužije ako komentár", () => {
  assert.equal(
    cleanSprejnamedvedaDescription(
      "V lokalite Dedovka bol zaznamenaný výskyt medveďa zo dňa 2026-06-05.\n\nV piatok 5."
    ),
    ""
  );
});

test("nesúvisiaci importovaný článok vyradí", () => {
  const description = "Automaticky zachyteny kandidat na rucnu kontrolu mapy. " +
    "Zdroj: Spravy STVR. Clanok: Tisíce drobných kvetov zafarbili lúky pod Kráľovou hoľou. " +
    "Odporucanie: overit v povodnom zdroji.";

  assert.equal(cleanSprejnamedvedaDescription(description), "");
  assert.equal(isRelevantSprejnamedvedaRow({ location: "Kráľovou hoľou", description }), false);
});

test("medvedí článok so zhodnou lokalitou prijme iba s konkrétnym detailom zdroja", () => {
  const description = "Automaticky zachyteny kandidat na rucnu kontrolu mapy. " +
    "Zdroj: Pozor medved. Clanok: Upozornenie na výskyt medveďa v obci Hrochoť. " +
    "Odporucanie: overit v povodnom zdroji.";
  const row = { location: "Hrochoť", description };

  assert.equal(isRelevantSprejnamedvedaRow(row), false);
  assert.equal(
    isRelevantSprejnamedvedaRow(row, { url: "https://www.sprejnamedveda.sk/aktuality/hrochot/" }),
    true
  );
});

test("medvedí článok s nesprávne priradenou lokalitou vyradí", () => {
  const description = "Automaticky zachyteny kandidat na rucnu kontrolu mapy. " +
    "Zdroj: Spravy STVR. Clanok: V obci Beluša odchytili malé medvieďa. " +
    "Odporucanie: overit v povodnom zdroji.";

  assert.equal(isRelevantSprejnamedvedaRow({ location: "Púchove", description }), false);
});

test("index článkov priradí detail podľa lokality a dátumu", () => {
  const index = buildSprejnamedvedaArticleIndex([{
    link: "https://www.sprejnamedveda.sk/aktuality/vyskyt-medveda-hrochot-25-6-2026/",
    title: { rendered: "Výskyt medveďa: Hrochoť &#8211; 25.&nbsp;6.&nbsp;2026" },
    excerpt: { rendered: "<p>Výskyt medveďa v lokalite Hrochoť zo dňa 25. 6. 2026. Medveď pri obci.</p>" },
  }]);

  assert.equal(index.get("hrochot|2026-06-25")?.url,
    "https://www.sprejnamedveda.sk/aktuality/vyskyt-medveda-hrochot-25-6-2026/");
});

test("normalizovaný bod odkazuje iba na stránku Aktuality", () => {
  const row = {
    location: "Hrochoť",
    title: "Hrochoť",
    observed_at: "2026-06-25",
    lat: 48.655,
    lng: 19.312,
    description: "Automaticky zachyteny kandidat na rucnu kontrolu mapy. " +
      "Zdroj: Pozor medved. Clanok: Upozornenie na výskyt medveďa v obci Hrochoť. " +
      "Odporucanie: overit v povodnom zdroji.",
  };
  const item = normalizeSprejnamedvedaRow(row, {
    url: "https://www.sprejnamedveda.sk/aktuality/vyskyt-medveda-hrochot-25-6-2026/",
    excerpt: "Výskyt medveďa v lokalite Hrochoť zo dňa 25. 6. 2026. Medveď pri obci.",
  });

  assert.equal(item.note, "Medveď pri obci.");
  assert.deepEqual(item.sourceLinks, [{
    key: "sprejnamedveda",
    label: "sprejnamedveda.sk",
    url: "https://www.sprejnamedveda.sk/aktuality/",
    sourceId: item.id.replace(/^sprejnamedveda-/, ""),
  }]);
  assert.equal(item.url, "https://www.sprejnamedveda.sk/aktuality/");
});
