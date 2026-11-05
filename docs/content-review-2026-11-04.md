# Content publication and saved blocks — 4 November 2026

Approved all 7 pending news records after source review. No news, imported sightings, or user reports remain pending. The news table contains 863 original rows: 748 approved and 115 rejected. Previously rejected records were preserved.

Reviewed and saved 43 article records across 13 blocks: 7 new blocks and 6 existing blocks extended. Saved 35 additional article links. Corrected warning locations and stale location hints in article payloads. Filled missing publication timestamps only where retrieved publisher metadata provided a date.

Saved 15 new sighting blocks and extended 2 existing sighting blocks, adding 32 membership links. Original sighting and user-report rows were unchanged.

## News blocks verified on the live feed

| Block | Incident ID | Published coverage records |
| --- | --- | ---: |
| Dolina Suchej Kasprovej, Poland | `482ad16e-96e1-4980-96c7-379c26f61523` | 4 |
| Veľká Fatra / Turiecfoto video | `c23f7d4a-1767-4580-a9f4-7d5ace67b3f1` | 2 |
| Nová Baňa warning | `f1def707-b815-45f6-a69c-46e4cb52c6ee` | 3 |
| Habura findings and subsequent official warning | `07e19a2a-b196-437e-b145-288c579dd492` | 7 |
| Medzibrod and Hronská Dúbrava joint warning | `1b13c3a5-2992-49a9-8dda-e4dcb722434d` | 5 |
| Liptov and Urpín weekend roundup | `5cd6e642-ff91-4e93-ad42-cf094916bbf2` | 8 |
| Mútnik, Liptovský Mikuláš | `8a67818b-1345-4a66-b502-533d8b4766bc` | 9 |
| Kvačianska dolina | `cfeeda5d-2f81-494a-85af-700713d24aa1` | 4 |
| Kláštorská cesta runner incident | `c0386434-1947-4d06-98c3-777df42eda72` | 21 |
| Official map edition of 8 October | `36a916ed-72a4-45b8-af30-b598ae2a0e5f` | 2 |
| STVR roundup: Vyšná Myšľa and Klátov | `b31eeab1-a38f-4c41-802d-956cc4ea5e4e` | 2 |
| Visit by Japanese bear-management expert | `430b735c-288b-4b87-8ce1-2026a4025a69` | 5 |
| Očová / 26 bears video | `431a9f00-10d0-4818-929d-0d7fc5189a16` | 9 |

## Location and source decisions

- The four Kasprowy video/gallery records cover the same 29 October encounter on the Polish side, as described by [Žilinak](https://www.zilinak.sk/clanky/43739/video-turista-sa-postavil-zoci-voci-medvedovi-v-zapadnych-tatrach-stretnutie-si-vyzadovalo-pevne-nervy). Approved as articles without Slovak map markers. Removed the erroneous “Vitajte vo V.Tatrách” location.
- The [Veľká Fatra camera-trap article](https://www.bystricak.sk/clanky/13556/video-zabery-z-velkej-fatry-zachytili-necakanu-reakciu-medveda-fotopasca-ho-vylakala-natolko-ze-sa-dal-na-rychly-utek) gives no exact camera position or recording date. Approved as an article and grouped with the corresponding Žilinak report. The block date is explicitly an approximate publication anchor.
- [Bystrica24's warning](https://bystrica.dnes24.sk/okres/kraj/pozor-na-medveda-ochranari-upozornili-na-selmu-v-blizkosti-stredoslovenskeho-mesta-478180) concerns Nová Baňa, despite its former Banská Bystrica coordinates. Corrected the location before approval.
- The approved [TA3 weekend roundup](https://www.ta3.com/slovensko/clanok/1075023/medvede-sa-objavili-na-viacerych-miestach-liptova-videli-ich-pri-obciach-aj-na-turistickom-chodniku) has four stored locations: Svätý Kríž, Závažná Poruba, Iľanovo, and Urpín – Vartovka. Reused the previously reviewed official notice's coordinates.
- Medzibrod/Hronská Dúbrava coverage retains both locations in each article. Multi-location blocks use the existing presentation behavior: the block has its primary locality, and coverage records retain their individual locations.
- Habura's summary distinguishes confirmed bear presence from the unconfirmed cause of the deer’s injuries. The Medzilaborce district reference was replaced with Habura as the actual warning locality.
- All nine Mútnik block members now use the previously reviewed Mútnik point near Liptovský Mikuláš, removing an unrelated same-name locality.
- Duplicates of the same publisher URL were linked to the already reviewed block without deleting original rows or changing URL aliases. The duplicate owner was checked to belong to the same block before attaching; audit entries record this decision.
- Separate map editions, separate observations in Terchová, general advice, and uncertain matches remain independent.

## Sighting blocks

New pairs: Kvačianska dolina, Kokava nad Rimavicou, Štiavnik, Mútnik, Oškerda, Tlstá, Terchová (droppings), Oravská Lesná, Nižná Boca, Hronská Dúbrava, Medzibrod, Mengusovská dolina, Snežnica, Habura, and Ďurďoš. Extended existing Vrátna and Tisovec blocks with their matching tumedved imports. Used the existing transactional `apply_sighting_bucket_plan` RPC.

## Verification and recovery files

Database read-back verified every planned article link, category, ordered warning location, sighting membership, and primary record. All source-row IDs and counts were retained. Records outside the 43 reviewed news rows were verified unchanged, including every imported sighting and user report.

Rebuilt the public snapshot successfully: revision `2286`, built revision `2286`, day `2026-11-04`. Live `/api/news` and `/api/warnings` returned HTTP 200, 209 news entries and 592 warnings. Verified all 13 news blocks and all 15 new sighting blocks in those live responses, including coverage IDs and the absence of map coordinates for the Polish and camera-trap articles.

Local recovery and audit files are under `C:/Users/matej/AppData/Local/Temp/medved-review-2026-11-04-`: `before.json`, `sources.json`, `plan.json`, `copy.json`, `progress.json`, `after.json`, and `verification.json`. Database audit actor: `codex:content-review:2026-11-04`.

No application code or deployment was changed. Validation consisted of database assertions, snapshot publication, and live API read-back.
