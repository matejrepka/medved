# Audit fungovania webu a backendu — 6. november 2026

Opravy sú pripravené v pracovnom priečinku. Neboli nasadené na produkciu a nemenia
existujúce funkcie, pravidlá moderovania ani vzhľad stránky. Testy používajú izolované
dáta a neposielajú skutočné hlásenia, e-maily ani Telegram notifikácie.

## Opravené chyby

| Problém | Oprava |
| --- | --- |
| Zlyhanie prvého načítania databázy sa zmenilo na úspešný prázdny zoznam správ alebo hlásení. Klient tak nemohol rozlíšiť výpadok od skutočne prázdnych dát. | Studený dátový store chybu odovzdá API, ktoré vráti chybový HTTP stav. Úspešná prázdna odpoveď databázy zostáva platná. Pri zlyhaní obnovy už načítaných dát sa zachová pôvodná kópia. |
| Zlyhanie načítania komunitných hlásení sa potichu zmenilo na neúplný úspešný zoznam varovaní. | Neúplný výsledok sa nezverejní ako úspešná cache; klient dostane chybu a môže zachovať predchádzajúci zoznam. |
| Obnova po zápise mohla prevziať výsledok databázového čítania spusteného ešte pred zápisom. | Vynútená obnova počká na predchádzajúce čítanie a následne načíta databázu znova. Používa ju import aj všetky existujúce cesty administrátorských úprav a moderovania. |
| Rozbehnuté čítanie mohlo po invalidácii opäť zaplniť cache starým obsahom. | Dátový store rozlišuje generácie načítania. Odvodené cache varovaní a prehľadu sa pri invalidácii nahradia; starší request môže dokončiť iba svoju vyradenú cache. |
| Administrátorské zápisy a mazanie mohli oznámiť úspech pri nenastavenej databáze, pretože repository operácie sa vtedy potichu skončili. | Po úspešnej autentifikácii sa takéto zápisy zastavia odpoveďou 503. |
| Spam kontrola hlásenia bežala bez pripojenia k životnosti Worker requestu. | Používa existujúci mechanizmus `defer` / `waitUntil`. Výsledok nemení moderovanie hlásenia. |
| Oneskorený geokóder, vyhľadávanie alebo poloha zariadenia mohli prepísať novšie vybrané miesto či potvrdenie polohy. | Iba výsledok poslednej aktívnej operácie smie upraviť výber. Potvrdenie a úspešné odoslanie vyradia staršie operácie. Počas vyhľadávania názvu zostávajú dostupné zodpovedajúce súradnice. |
| Vyhľadávanie názvu miesta nemalo časový limit ani kontrolu HTTP stavu; blokované browserové úložisko prerušilo prepnutie témy vo formulári. | Geokódovacie čítania majú limit osem sekúnd a kontrolu odpovede. Vyhľadané súradnice sa validujú. Zlyhanie uloženia témy nezastaví obsluhu stránky. |
| Nenahraná knižnica grafov zastavila celý skript štatistík; zaseknuté API nechávalo stránku v stave načítavania. | Číselné štatistiky fungujú aj bez grafov a stránka zobrazí zodpovedajúcu chybu. Čítanie štatistík má limit 15 sekúnd. |
| Browserové regresné testy čakali na už odstránený súhlasový banner a mapové fixtures vypadli z predvoleného sedemdňového filtra. | Odstránené zastarané kroky; mapové fixtures používajú aktuálny dátum. Pridaná kontrola stránky „Spomenuli nás“. |

## Závislosti

Produkčný audit `npm audit --omit=dev` bol vykonaný s výslovným súhlasom používateľa.
Kompatibilné aktualizácie sú uložené v lockfile:

| Balík | Pred opravou | Po oprave |
| --- | --- | --- |
| body-parser | 1.20.8 | 1.20.9 |
| nodemailer | 10.0.13 | 10.3.1 |
| qs | 6.16.0 | 6.16.2 |

`body-parser` opravuje možnosť pádu servera po komprimovanom tele s neplatnými
koncovými bajtmi. Pridaný HTTP regresný test overuje chybovú odpoveď aj ďalšiu
dostupnosť servera. [Bezpečnostné hlásenie](https://github.com/advisories/GHSA-27r3-jxmh-p828).

Výsledok auditu po aktualizácii: **0 critical, 0 high, 0 moderate, 3 low**.
Tri low záznamy predstavujú jeden reťazec závislostí:
`puppeteer-extra-plugin-stealth → puppeteer-extra-plugin-user-preferences → deepmerge`.
Pre `deepmerge` 4.3.1 nie je vydaná opravená verzia.
[Bezpečnostné hlásenie](https://github.com/advisories/GHSA-gcqx-w48m-w2h4).

V tomto projekte sa `deepmerge` používa na skladanie konfigurácie scraperového
prehliadača z nastavení pluginov. Pri kontrole sa nenašlo odovzdávanie verejných
formulárov ani stiahnutého obsahu do tejto konfigurácie. Worker tento browserový
modul pri zostavení nahrádza vlastným modulom. Toto posúdenie obmedzuje aktuálnu
dosiahnuteľnosť nálezu, nenahrádza opravu upstream balíka. Automaticky navrhovaný
downgrade stealth pluginu nebol aplikovaný, aby sa nezmenila funkčnosť scraperov.

## Overenie

- `npm test`: **187 testov úspešných**, bez vynechaných testov.
- `npm run check`: kontrola syntaxe, inline skriptov a SEO šablón úspešná.
- `npm run check:worker`: úspešné API, runtime bindingy a ich rotácia, SSR,
  detailné a lokálne stránky, cache a jej revízie, statické súbory aj súbežný
  štart s 650 hláseniami a 220 správami.
- `npm run check:browser`: verejné stránky, administrátorské prihlásenie,
  mobilná navigácia a validácia hlásenia.
- `npm run check:startup`: desktop, mobil a tmavý režim; postupné načítanie
  podkladov a oboch feedov; pomalé a chybové odpovede; opakovanie načítania;
  zachovanie existujúceho obsahu pri výpadku; dostupnosť zoznamov bez JavaScriptu.
- Nový `npm run check:resilience`: súbeh geokódovania, vyhľadávania a polohy
  zariadenia; potvrdenie počas čakania; zamietnuté úložisko; funkčné grafy,
  chýbajúca knižnica grafov a timeout štatistík.
- Produkčný audit závislostí po aktualizácii; `git diff --check` bez chýb.

Lokálne testy neoverujú stav produkčnej databázy, skutočné doručovanie notifikácií
ani aktuálnu priechodnosť externých scraperov. Produkčná databázová schéma ani
produkčné záznamy neboli zmenené. Nasadenie zostáva samostatný krok.

## Druhé kolo kontroly

Ďalších 24 regresných testov odhalilo a overilo tieto opravy:

| Problém | Oprava |
| --- | --- |
| Kontrola ručných úprav a stavov importovaných hlásení ignorovala každú chybu databázy, vrátane timeoutu alebo zamietnutých oprávnení. Import potom mohol pokračovať bez ochrany údajov. | Zápis sa zastaví. Kompatibilný postup bez príslušného stĺpca zostáva iba pre konkrétnu chybu chýbajúceho stĺpca. |
| Administrácia požadovala až 2 000 záznamov jednou odpoveďou, ktorú môže databázové API orezať. | Načíta stránky po 500 záznamoch až do existujúceho limitu zoznamu. Rovnaké dátumy majú stabilné zoradenie podľa ID. Chyba ďalšej stránky nezmení neúplný výsledok na úspešný. |
| Dávka 200 správ môže obsahovať až 2 400 lokalít; jedna odpoveď časť z nich vynechala. | Stránkujú sa aj lokality, so stabilným poradím článku a pozície. |
| Opakovanie AI spracovania bez nového výsledku znova zapisovalo nezmenený súhrn a rušilo verejnú cache. | Nezmenené súhrny bez nového AI výsledku sa nezapisujú. Skutočne nový súhrn sa naďalej uloží. |
| Výmena lokalít používala samostatné zmazanie a vloženie. Po zlyhaní vloženia sa pôvodné lokality stratili. | Výmenu samotného zoznamu vykonáva jedna transakčná RPC funkcia so zámkom záznamu článku. Neplatné súradnice, duplicitné názvy či iná chyba vloženia vrátia pôvodný zoznam. Pri chýbajúcej migrácii sa nepoužije deštruktívny náhradný postup. |
| Schválenie varovania so starším formátom jednej lokality ju použilo v článku, ale neodovzdalo ju ukladaniu zoznamu lokalít. | Ukladajú sa tie isté normalizované lokality, ktoré sa použili pri moderovaní. |
| Import správ preskočil súbežne vloženú duplicitu, ale následne aj tak prepísal jej lokality. | Následné uloženie lokalít dostanú iba ID skutočne nových vložených článkov. |
| Jeden neplatný RSS alebo WordPress dátum mohol prerušiť celý import alebo zahodiť dávku zdroja. | Neplatný dátum sa spracuje ako neznámy; ďalšie články zostanú dostupné. |
| Úplný výpadok zdrojov správ alebo neplatná WordPress odpoveď sa vykázali ako úspešné stiahnutie nula článkov. | Úplný výpadok je chyba obnovy. Funkčný zdroj stále poskytne svoje články a úspešná prázdna odpoveď ostáva platná. |
| Neplatný objekt namiesto dátumu v administrátorskom API mohol vyhodiť výnimku mimo obsluhy chyby Expressu. | Typ a dĺžka dátumu sa overia pred vytvorením dátumu a pred databázovým zápisom; server vráti 400 a zostane dostupný. |

Overenie druhého kola: **211 úspešných testov**, `npm run check` a
`npm run check:worker`. Nová SQL funkcia bola vykonaná v lokálnom PostgreSQL
prostredí PGlite. Testy overujú rollback po chybe vloženia, opakovateľnosť migrácie,
zmenu poradia lokalít, vyprázdnenie zoznamu a zákaz spustenia pre `anon` a
`authenticated`; funkcia používa `security invoker` a oprávnenie má `service_role`.

### Poradie nasadenia druhej sady opráv

1. V existujúcej Supabase databáze najprv spustiť celý obsah súboru
   [`20261106205315_atomic_news_warning_locations.sql`](../supabase/migrations/20261106205315_atomic_news_warning_locations.sql).
   Vytvára súkromnú funkciu nad tabuľkami z migrácie 006; existujúce údaje nemení.
   Migráciu možno aplikovať opakovane a pôvodný backend ju nevyžaduje ani ňou nie je ovplyvnený.
2. Až potom nasadiť nový Worker a Node importný proces, ktorý túto funkciu používa.

Migrácia bola pripravená cez oficiálne Supabase CLI, ale na produkciu nebola aplikovaná.
Produkčné databázové advisors neboli spustené; lokálne testy overili oprávnenia a
transakčné správanie novej funkcie. Širší stav produkčnej databázy tým nie je overený.
