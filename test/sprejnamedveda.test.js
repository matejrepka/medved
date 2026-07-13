import test from "node:test";
import assert from "node:assert/strict";

import { cleanSprejnamedvedaDescription } from "../src/scrapers/sprejnamedveda.js";

test("odstráni redakčný obal a ponechá pôvodnú poznámku zo zdroja", () => {
  const raw = "Automaticky zachyteny kandidat z verejnej mapy na rucnu kontrolu. " +
    "Zdroj: TuMedved.sk. Odporucanie: overit datum. Cas hlasenia: 19:35. " +
    "Poznamka zo zdroja: medveď bol približne 20 m od rybníka";

  assert.equal(
    cleanSprejnamedvedaDescription(raw),
    "medveď bol približne 20 m od rybníka"
  );
});

test("z importovaného článku ponechá iba opis udalosti", () => {
  const raw = "Automaticky zachyteny kandidat na rucnu kontrolu mapy. " +
    "Zdroj: Pozor medved. Clanok: Upozornenie na výskyt medveďa v obci Hrochoť. " +
    "Odporucanie: overit v povodnom zdroji presnu lokalitu.";

  assert.equal(
    cleanSprejnamedvedaDescription(raw),
    "Upozornenie na výskyt medveďa v obci Hrochoť"
  );
});

test("prázdny draft import nezobrazuje ako komentár", () => {
  assert.equal(
    cleanSprejnamedvedaDescription("Draft import 2026. Zdroj: Pozor medved. Overit pred publikovanim."),
    ""
  );
});

test("interný import bez pôvodnej poznámky nezobrazuje ako komentár", () => {
  assert.equal(
    cleanSprejnamedvedaDescription(
      "Automaticky zachyteny kandidat z verejnej mapy na rucnu kontrolu. " +
      "Zdroj: TuMedved.sk. Odporucanie: overit datum a presnu polohu."
    ),
    ""
  );
});

test("bežný komentár ponechá bez zmeny", () => {
  assert.equal(
    cleanSprejnamedvedaDescription("Medvedica s mláďaťom prešla cez cestu."),
    "Medvedica s mláďaťom prešla cez cestu."
  );
});
