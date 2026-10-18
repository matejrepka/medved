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
2. S premennými `SUPABASE_URL` a `SUPABASE_SERVICE_ROLE_KEY` správneho projektu
   spustite `npm run precompute:public`. Overte úspešné uloženie prvého výsledku.
3. Nasaďte Worker a pushnite workflow súbory do predvolenej vetvy GitHubu.
   GitHub secrets musia smerovať na ten istý projekt ako Worker.
4. Overte `/api/stats`, `/domov` a existujúcu `/vyskyt-medveda/<slug>` stránku.
   V Cloudflare skontrolujte, že Worker už nemá Cron Trigger. Nasadenie konfigurácie
   s `triggers.crons: []` odstráni predchádzajúci päťminútový plán.

Workflow `precompute.yml` kontroluje dáta každých 15 minút. Výsledok sa zostaví
po zmene revízie alebo po zmene dňa v časovom pásme Europe/Bratislava. Pri nezmenených
dátach sa výpočet preskočí. Kontrola nepotrebuje Chromium ani AI.
Workflow importu dát spustí predpočítanie aj po svojom behu. Plány GitHub Actions
môžu mať oneskorenie a podliehajú dostupnosti a kvótam daného repozitára.

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
