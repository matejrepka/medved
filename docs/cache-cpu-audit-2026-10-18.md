# Audit cache, CPU a Supabase prenosov

Dátum: 18. 10. 2026, približne 19:15–19:21 Europe/Bratislava.
Cieľ: produkčný Worker `medved`, `https://www.kdejemedved.sk`, Supabase projekt `ifwxjvlpynbcwbqueccs`.
Audit je read-only; nemení aplikačný kód, databázu, produkčnú konfiguráciu ani GitHub.

## Záver

Cache funguje čiastočne. Verejné štatistiky a adresár sa už počítajú mimo HTTP Workera. Pamäťová cache správ a varovaní má 60 sekúnd a spája súbežné načítania. Chýba však explicitná cache celých dynamických odpovedí na Cloudflare, cache jednotlivých štatistík/lokalít a kontrola revízie pred opätovným prenosom veľkých feedov. Inkrementálne načítanie iba nových alebo upravených databázových záznamov implementované nie je.

## Nálezy podľa priority

### P1: Automatický prepočet ešte nie je publikovaný

Pripravený `.github/workflows/precompute.yml` nie je v aktuálnom HEAD `d5a7205`; publikovaný refresh workflow nemá krok `precompute:public`. Predošlý pokus o commit/push zastavila automatická kontrola oprávnení. Lokálne pripravené workflow súbory samy na GitHube nebežia.

Migrácia 011 zvyšuje revíziu pri zápisoch do zdrojových tabuliek. RPC vráti obsah iba pri `built_revision = revision`. Po nasledujúcom importe alebo moderácii preto môžu štatistiky a lokality zostať na 503 do manuálneho prepočtu. Správy/varovania použijú drahší fallback na zdrojové tabuľky. Denná aktualizácia časových štatistík sa takisto automaticky nespustí.

Odporúčanie: publikovať pripravený prepočet aj krok po importe; na GitHube overiť reálny úspešný beh a existujúce secrets. Publikovanie do hlavnej vetvy naďalej vyžaduje výslovné schválenie používateľa.

### P2: Štatistiky a jednotlivé lokality volajú Supabase pri každej požiadavke

`server.js:1296` volá `loadPublicSnapshot({ kind: "stats" })` bez pamäťovej cache. `server.js:1807` to robí pre každú lokalitu. `src/db/public-snapshot.js:14` vykonáva priamo RPC bez cache. Hlavička `Cache-Control` pomáha prehliadaču; v samotnej aplikácii nenahrádza cache odpovede medzi návštevníkmi.

Odporúčanie: ohraničená cache s TTL a spájaním súbežných requestov; pri lokálnych moderáciách invalidácia. Zachovať kontrolu dostupnosti snapshotu a rozumnú hranicu zastarania. Negatívne výsledky ani chyby necachovať dlho.

### P2: Pamäťová cache nezabraňuje opätovnému prenosu nezmenených feedov

`src/scheduled-store.js:2` má predvolené `maxAgeMs = 60000`. Po expirácii zavolá celý `loadStored`; nový izolát začína s prázdnou pamäťou. Správy a varovania z platného snapshotu nesťahujú zdrojové tabuľky, ale opakovane načítajú celý svoj JSON dokument.

Namerané veľkosti dokumentov v Supabase (JSON text, bez HTTP kompresie):

| Dokument | Bajty |
| --- | ---: |
| stats | 1 983 |
| overview | 45 755 |
| news | 553 233 |
| warnings | 489 542 |

Oba feedy spolu majú približne 1,04 MB pri jednom plnom obnovení. Skutočný účtovaný prenos môže mať inú veľkosť; nejde o odhad dennej spotreby.

Odporúčanie: najprv lacno skontrolovať `revision`/`built_revision` a dokument stiahnuť iba pri zmene. Cache podľa revízie držať aj mimo jedného izolátu. Pri prípadnej inkrementálnej synchronizácii riadkov zahrnúť úpravy starých záznamov, zmeny moderácie a odstránenia; samotný filter podľa posledného dátumu publikovania by bol nesprávny.

### P2: Dynamické odpovede sa stále renderujú a serializujú

`workers/index.js` vždy odovzdá request Expressu. V implementácii nie je `caches.default.match/put`. Pri každom API requeste sa mapujú položky, vytvárajú detailné URL a serializuje veľký JSON; HTML sa znova renderuje. Aj HTTP 304 sa vyhodnotí až pri odosielaní odpovede Expressom, po vykonaní handlera a jeho databázových volaní.

Pri troch opakovaných požiadavkách na dynamické trasy nebolo `CF-Cache-Status: HIT` ani `Age`. Samotná absencia hlavičky nie je dôkazom všetkých externých nastavení, ale spolu s kódom neposkytuje dôkaz o zdieľanej cache dynamických odpovedí.

Odporúčanie: krátka cache úspešných verejných GET odpovedí pred Expressom, s presnými pravidlami pre query parametre. Nikdy nezahrnúť admin, autentifikované requesty, mutácie, formuláre, cookies alebo chybové odpovede. TTL musí rešpektovať moderáciu. Cloudflare Cache API je lokálne pre dátové centrum a stále vyvolá Worker; zníži však prácu handlera a databázové prenosy.

### P3: Import a fallback opakujú prácu so starými riadkami

`loadTumedvedLogs` (`src/db/repository.js:567`) číta najviac 1000 schválených riadkov vrátane payloadov. `loadNewsLogs` (`:598`) má tri čiastočne sa prekrývajúce dotazy, následne číta lokality a incidentové väzby. Nie je tu synchronizácia pomocou `updated_at` alebo kurzora.

`saveTumedvedLogs` (`:302`) upsertuje aj existujúcich kandidátov s novým `updated_at`. Triggre snapshotu sú na úrovni SQL statementu a nerozlišujú, či sa zmenil verejný obsah. Preto sa revízia môže zmeniť aj pri importe rovnakých hlásení. Správy už majú kontrolu existujúcich ID a hotové články neprepisujú plošne.

Odporúčanie: ukladať iba obsahovo zmenené hlásenia a invalidovať snapshot iba pri zmene verejných dát. Oddeliť technický čas scrapingu od obsahu. Pri neplatnom snapshote obmedziť drahé opakované fallback dotazy.

### P3: Statické súbory a mapové dlaždice prechádzajú Workerom

`wrangler.jsonc` má `run_worker_first: true`. `workers/platform.js` prečíta odpoveď ASSETS do `arrayBuffer` a zabalí do Buffer pred odoslaním cez Express. Statický asset samotný môže byť cache HIT, ale každý request stále spustí Worker.

Mapové dlaždice majú ročnú browser cache, ale handler vykonáva `fetch` na CARTO a číta celé telo pri každom requeste, ktorý príde až k nemu. Vlastná cache dlaždíc pred handlerom tu nie je. Upstream CDN môže cachovať samostatne; audit nepotvrdil jej hit rate.

Odporúčanie: nechať vhodné statické trasy obslúžiť priamo assets routovaním a pre dlaždice zvážiť explicitnú cache úspešných odpovedí. Pri zmene routovania zachovať SSR, presmerovania a bezpečnostné hlavičky.

## Čo funguje správne

- Verejné HTTP requesty neimportujú `buildPublicOverview`; náročné prepočty sú v samostatnom Node skripte.
- `precompute:public` pri rovnakej revízii a rovnakom bratislavskom dni preskočí výpočet. Pri zmene však znovu načíta celé podklady.
- Správy a varovania majú pamäťovú cache, TTL a ochranu pred duplicitným súbežným načítaním.
- RPC vracia iba požadovaný dokument, nie celý snapshot so všetkými lokalitami.
- Statický `/app.js` v živom teste vrátil `CF-Cache-Status: HIT`; podmienený request vrátil 304.
- `/api/news`, `/api/warnings`, `/api/stats` v korektnom podmienenom requeste vrátili 304. Tým sa šetrí telo odpovede klientovi, nie automaticky práca handlera.
- Cloudflare Worker nemá scheduled handler ani cron. E-maily sú vypnuté a zapisovanie `website_logs` je predvolene vypnuté.

## Produkčné meranie CPU

Cloudflare GraphQL `workersInvocationsAdaptive`, Worker `medved`, od `2026-10-18T17:15:00Z` do okamihu merania približne 17:19 UTC. Ide o krátky interval po nasadení, nie dlhodobý záťažový test ani flamegraph.

- Úspešné požiadavky: 908; subrequesty: 912. Subrequesty zahŕňajú aj iné ciele než Supabase.
- CPU P50 úspešných requestov: 3 391 mikrosekúnd = 3,391 ms.
- CPU P99: 29 061 mikrosekúnd = 29,061 ms.
- 4 odpojenia klienta, 1 `scriptThrewException`; príčina tejto výnimky nebola týmto auditom určená.
- V tomto intervale nebol vrátený stav `exceededResources`. Širší hodinový interval zahŕňajúci čas pred nasadením ho obsahoval, takže nie je vhodný na hodnotenie iba novej verzie.

Jednotky CPU boli overené priamo v introspekcii Cloudflare GraphQL schémy. Nameraná sieťová odozva nie je CPU čas.

## Supabase logy a obrázok spotreby

Za predvolených posledných 24 hodín boli medzi edge requestmi napríklad: 8 134 volaní `news_warning_locations`, 5 458 `incident_news_links`, 5 433 `news_logs` a 5 247 `website_logs`. Tieto čísla zahŕňajú starú verziu pred dnešným nasadením a nie sú dôkazom pokračovania tohto správania v novej verzii.

V krátkom intervale od 17:15 UTC logy ukázali 33 volaní `read_public_snapshot` a žiadne z uvedených zdrojových feedových tabuliek. Časť tvorí samotný audit. Nový snapshotový postup teda v meranom intervale skutočne nahradil pôvodné dotazy.

Hlavička `content_length` pri mnohých Supabase odpovediach v logoch chýba. Súčet dostupných hodnôt by preto výrazne podhodnotil egress; z týchto logov nemožno poctivo vypočítať celý denný prenos.

Priložený obrázok ukazuje 4,42 GB z 5 GB uncached egress a 0 GB cached egress. Neurčuje príspevok jednotlivých projektov ani účinok dnešného nasadenia. Supabase cached egress sa vzťahuje na jeho vlastnú CDN, najmä Storage; cache v Cloudflare alebo pamäti Workera sa v tejto položke neobjaví.

## Poradie nápravy

1. Publikovať a overiť automatický prepočet; predísť trvalému neplatnému snapshotu.
2. Zaviesť bezpečnú krátku cache verejných odpovedí a dokumentov stats/location.
3. Pred veľkým prenosom kontrolovať revíziu a znovu používať nezmenené dokumenty.
4. Obmedziť prepisovanie nezmenených hlásení a zbytočné invalidácie.
5. Odľahčiť routovanie statických assetov a cache dlaždíc.
6. Potom porovnať CPU a Supabase prenosy za porovnateľné celé dni a zistiť príčinu zaznamenanej výnimky.

## Dokumentácia

- [Cloudflare Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)
- [Cloudflare Workers GraphQL metrics](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/)
- [Cloudflare production profiling](https://developers.cloudflare.com/workers/observability/profiling-in-production/)
- [Supabase egress](https://supabase.com/docs/guides/platform/manage-your-usage/egress)
- [Supabase egress troubleshooting](https://supabase.com/docs/guides/troubleshooting/all-about-supabase-egress-a_Sg_e)
