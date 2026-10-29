# Predpočítané štatistiky, lokality a ručné skupiny hlásení

Verejný Worker číta hotový JSON zo Supabase. Výpočet štatistík, rozpoznávanie
lokalít pre report a zostavovanie adresára lokalít beží iba v Node procese
`npm run precompute:public`. HTTP požiadavka tento výpočet nikdy nespúšťa.
Ten istý proces pripraví aj verejné zoznamy správ a varovaní. Worker pri platnom
výsledku číta jeden uložený dokument namiesto opakovaných dotazov na správy,
lokality a incidentové väzby. Každá trasa dostane iba svoj dokument: štatistiky,
adresár bez tiel záznamov alebo jednu lokalitu.

## Nasadenie

1. V správnom Supabase projekte spustite celý súbor
   `docs/migration-011-public-snapshots-buckets.sql` po migráciách 001–010.
   Migrácia zachová pôvodné záznamy, existujúce incidenty aj históriu odosielania.
   Nové tabuľky a RPC sú dostupné len serverovej `service_role`.
2. Aplikujte aj `supabase/migrations/20261018172624_cache_unchanged_sightings.sql`.
   Nezmenené hlásenia sa pri opakovanom importe fyzicky neprepíšu a prázdne
   zápisy neinvalidujú snapshot. Migrácia nemení obsah existujúcich hlásení.
3. S premennými `SUPABASE_URL` a `SUPABASE_SERVICE_ROLE_KEY` správneho projektu
   spustite `npm run precompute:public`. Overte úspešné uloženie prvého výsledku.
   Pre aktualizáciu detailov aplikujte aj
   `supabase/migrations/20261018184716_record_detail_documents.sql`, potom
   `supabase/migrations/20261018185139_record_publish_safe_updates.sql` a spustite
   `npm run precompute:public -- --force` pred nasadením Workera. Publikujte aj
   aktualizovaný `src/db/public-snapshot.js` a nový `src/record-documents.js`, aby
   background workflow vytváral detaily pri každom ďalšom prepočte.
4. Nasaďte Worker a pushnite workflow súbory do predvolenej vetvy GitHubu.
   GitHub secrets musia smerovať na ten istý projekt ako Worker.
5. Overte `/api/stats`, `/domov` a existujúcu `/vyskyt-medveda/<slug>` stránku.
   V Cloudflare skontrolujte, že Worker už nemá Cron Trigger. Nasadenie konfigurácie
   s `triggers.crons: []` odstráni predchádzajúci päťminútový plán.

Workflow `precompute.yml` kontroluje dáta každých 15 minút. Výsledok sa zostaví
po zmene revízie alebo po zmene dňa v časovom pásme Europe/Bratislava. Pri nezmenených
dátach sa výpočet preskočí. Kontrola nepotrebuje Chromium ani AI.
Workflow importu dát spustí predpočítanie aj po svojom behu. Plány GitHub Actions
môžu mať oneskorenie a podliehajú dostupnosti a kvótam daného repozitára.

### Odolnosť publikovania a diagnostika

Aplikujte aj `supabase/migrations/20261022094010_optimize_snapshot_publication.sql`.
Následne aplikujte
`supabase/migrations/20261029084849_materialize_snapshot_record_keys.sql`.
Prvá optimalizácia sama nestačí: aj odovzdanie veľkej PL/pgSQL premennej operátoru
`?` pri každom uloženom riadku opakovane kopíruje celý JSON a môže prekročiť limit
API. Nová funkcia vyberie iba kľúče pomocou `jsonb_object_keys` v nekorelovanom
poddotaze; databáza si ich pripraví raz a pri mazaní kontroluje tento malý zoznam.
Zachováva spoločnú transakciu, kontrolu revízie, odstránenie chýbajúcich detailov
aj vynechanie zápisov nezmenených detailov. Globálne timeouty sa nemenia.

Aplikujte aj `supabase/migrations/20261029085858_budget_snapshot_publication.sql`.
Publikačné RPC má vlastný limit 30 sekúnd a `work_mem=16MB`: pri približne 9 MB
dokumentov už nezávisí od predvoleného 8-sekundového API limitu a nízkej pracovnej
pamäte, ktorá spôsobovala zápis medzivýsledkov na disk. Nastavenia platia iba počas
tejto privátnej funkcie; limity ostatných požiadaviek a rolí sa nemenia. Migrácia
obnoví schému PostgREST, aby sa limit uplatnil už pred vykonaním RPC príkazu.
Postup vychádza z dokumentácie
[Supabase pre limity funkcií](https://supabase.com/docs/guides/database/postgres/timeouts#function-level).

Po migrácii spustite `npm run precompute:public -- --force`, aby sa overilo skutočné
publikovanie aj pri už aktuálnej revízii. Samostatný workflow aj prepočet po importe
používajú tú istú opravenú databázovú funkciu bez zmeny volania.

`precompute:public` má najviac tri pokusy. Pri databázovom `statement timeout`
(`57014`) alebo nedostupnom zámku (`55P03`) počká 2 sekundy, potom 5 sekúnd a znovu
načíta revíziu aj zdrojové dáta. Chyby oprávnení, neplatný payload a manuálne
zrušenie príkazu sa neopakujú. Zmena revízie počas výpočtu naďalej vyvolá nový
výpočet v rámci rovnakého limitu troch pokusov.

Log `[snapshot]` uvádza číslo pokusu, čas načítania každého zdroja, zostavenia
prehľadu, prípravy detailov a publikovania, počet detailov a celkové trvanie.
Pri chybe uvádza fázu aj databázový kód; neobsahuje samotné dokumenty ani kľúče.
Rovnaké správanie používa samostatný workflow aj prepočet po importe dát.

### Cache verejných dát

Worker kontroluje malé metadáta revízie najviac raz za 15 sekúnd v jednom
izoláte. Dokumenty `stats`, `overview`, `news`, `warnings` a jednotlivé lokality
uchováva do zmeny publikovanej revízie; používa ohraničenú LRU cache so 128
dokumentmi. Rovnaká revízia nevyvolá nový prenos veľkého dokumentu. Verzia zahŕňa
aj čas publikovania, takže denný prepočet bez zmeny zdrojových dát cache obnoví.
Súbežné načítania metadát aj rovnakého dokumentu sa spájajú. Pri neplatnom snapshote
sa staré dokumenty nevracajú a chyby sa neukladajú ako úspešný výsledok.

Úspešné verejné GET odpovede pre mapu, domov, archívy, štatistiky a lokality sú
uložené v Cloudflare Cache API na 60 sekúnd pod kľúčom obsahujúcim projekt,
publikovanú revíziu a query parametre. Hlavička `X-Medved-Cache: HIT` znamená,
že sa preskočil Express, renderovanie a serializácia. Browser TTL je 15 sekúnd.
Zmena revízie vyradí staré kľúče pri najbližšej kontrole metadát; pri bežných
požiadavkách je preto možná približne 30-sekundová latencia do zobrazenia zmeny
(15 s metadáta + 15 s browser). Otvorená mapa má vlastný 15-minútový interval
obnovy a nový obsah zobrazí až pri svojom ďalšom načítaní.

Požiadavky s cookies, Authorization alebo Range, administračné trasy, mutácie,
neznáme query parametre a chybové odpovede sa do zdieľanej cache nedávajú.
Cache API sa zdieľa iba v rámci jedného dátového centra. Prvý request v novom
izoláte alebo po evikcii môže stále načítať celý potrebný dokument; nejde o
trvalú inkrementálnu repliku databázy. Statické súbory a mapové dlaždice si
zachovávajú existujúce správanie.

Detaily `/spravy/<slug>` a `/varovania/<slug>` majú rovnakú cache celých odpovedí.
Pri studenom requeste sa číta iba dokument jedného záznamu z indexovanej privátnej
tabuľky `public_record_snapshots`, vrátane najviac štyroch súvisiacich kariet a
odkazov na jeho lokality. Na vyhľadanie detailu sa nesťahujú celé feedy ani sa
neopakujú plné načítania pri neexistujúcom tokene. Dokumenty sa publikujú v jednej
transakcii so snapshotom a pri zmene revízie sa tiež prestanú čítať. Pôvodné URL,
presmerovania a odkazy na členov ručných skupín zostávajú zachované. Stránky lokalít
načítajú iba uložený adresár a dokument danej lokality, bez plných feedov.

Databázové triggre iba zvýšia revíziu. Ak sa dáta zmenia počas výpočtu, uloženie sa
odmietne a proces výpočet zopakuje. Starý JSON s už zamietnutými položkami sa po
zneplatnení nečíta. Do ďalšieho úspešného predpočítania vrátia štatistiky a stránky
lokalít dočasnú odpoveď 503 s Retry-After; mapa, zoznamy a detaily samostatných
záznamov naďalej čítajú schválené dáta. Pamäťová a HTTP cache môžu držať predchádzajúcu
odpoveď ešte 60 sekúnd. Prvý výsledok preto vytvorte pred nasadením.
Počas zneplatnenia používajú zoznamy správ/varovaní priamo schválené zdrojové
tabuľky ako dočasný fallback, aby moderácia nevyprázdnila mapu.

Zapisovanie návštev do `website_logs` je predvolene vypnuté. Na výslovné zapnutie
nastavte `ENABLE_WEBSITE_LOGS=true` a nepoužívajte `DISABLE_WEBSITE_LOGS=true`.
Vypnutie tohto zápisu neodstraňuje systémové logy Supabase API Gateway; ich počet
znižuje hlavne obmedzenie samotných databázových volaní.

## Zoskupovanie na výslovný pokyn

Import, schvaľovanie ani verejné čítanie neporovnávajú podobnosť hlásení. Každé nové
hlásenie sa uchová samostatne so stabilným ID. Existujúce odkazy medzi spravodajskými
článkami a incidentmi zostanú uložené; schválenie nového článku žiadny odkaz nevytvorí.

Pri pokyne na zoskupenie Codex skontroluje pôvodné záznamy a pripraví JSON plán:

```json
[
  {
    "primaryKey": "sighting:tm-123",
    "memberKeys": ["sighting:tm-123", "report:42"]
  }
]
```

`sighting:<id>` označuje presné ID z `tumedved_logs`, `report:<id>` označuje číselné
ID z `bear_reports`. Použite skutočné ID; uvedené hodnoty sú iba príklad.

```sh
npm run group:sightings -- --plan=tmp/buckets.json
npm run group:sightings -- --plan=tmp/buckets.json --apply
```

Prvý príkaz zobrazí plán. Druhý uloží väzby transakčne do `sighting_buckets` a
`sighting_bucket_members` a obnoví štatistiky/lokality. Bez `--apply` sa nič nezapisuje.
Databáza overí existenciu a schválenie členov; jeden záznam môže patriť iba do jednej
skupiny. Pôvodné hlásenia sa nemažú. Worker iba zobrazí uložené členstvo bez
výpočtu podobnosti. Zamietnutý člen sa nezobrazí a pri zamietnutí hlavného člena sa
použije zostávajúci schválený člen.

Na úpravu existujúcej skupiny doplňte jej `id` a celý nový zoznam `memberKeys`.
Na zrušenie skupiny pošlite jej `id` a prázdne `memberKeys`. Pri presune člena medzi
skupinami zahrňte obe dotknuté skupiny do jedného plánu. Ostatné skupiny ostanú bez
zmeny. Ak uloženie väzieb uspeje, ale následné predpočítanie zlyhá, zopakujte iba
`npm run precompute:public`; nezakladajte tie isté skupiny znova bez ich `id`.

Spravodajské incidenty možno na výslovný pokyn spracovať existujúcim offline
`npm run backfill:news-incidents` (najprv náhľad, potom `-- --apply`). Jeho
porovnávacia logika je v `scripts/lib/automatic-news-incidents.mjs` a HTTP server ju
neimportuje. Existujúce historické zlúčené payloady táto migrácia spätne nerozdeľuje.

## Pozastavené e-maily

Server neodosiela e-mailové súhrny, potvrdenia, moderátorské e-maily ani feedback
e-maily, aj keď sú SMTP premenné vyplnené. E-mailový polling sa nespúšťa a migrácia
vypne tri triggre vytvárajúce newsletterové úlohy. História a existujúce fronty sa
zachovajú. Cloudflare päťminútový cron a jeho scheduled handler sú odstránené.
Nakonfigurované priame Telegram oznámenia a webhook zostávajú dostupné.
