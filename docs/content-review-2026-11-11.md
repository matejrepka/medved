# Content review and saved buckets — 11 November 2026

Processed newest pending items first, then reviewed candidate matches among already approved content. Screened all 163 approved articles without incident links and unbucketed imported sightings. Retrieved publisher text/metadata for 61 source records; inaccessible or ambiguous matches remain independent.

Approved four of the six pending records and rejected two. No pending news, sightings, or user reports remain. All 882 original news records remain: 763 approved and 119 rejected. Previously rejected records were preserved.

Saved 23 additional article links across 16 buckets: six new buckets and ten existing buckets extended. Saved eight new sighting buckets containing 16 original reports. Changed 28 news rows; all other news rows, imported sighting rows, user-report rows, and existing memberships were verified unchanged.

## Newest moderation decisions

- **Habura:** approved as a warning and attached to the existing 29 October findings/official-warning bucket. Restored the publisher date, 29 October at 20:29 UTC. The summary distinguishes the unconfirmed cause of the deer’s injuries from the later confirmed bear presence. [Publisher](https://www1.pluska.sk/regiony/krvave-stopy-v-obci-habura-a-uhynuta-jelenica-obyvatelia-sa-obavaju-medveda).
- **Brusno:** approved as a warning in a separate 9 November bucket. The source explicitly dates the encounter to 13:30 behind the spa toward Trosky; physical attack is not confirmed. Reused the existing indicative map-report point, rather than the village centre. [Publisher](https://www1.pluska.sk/regiony/stret-s-medvedicou-za-kupelmi-brusno-obec-prosi-ludi-o-opatrnost).
- **Mútnik:** approved and attached to the existing 27 October municipal warning. Corrected the wrong same-name locality to the previously reviewed Mútnik point near Liptovský Mikuláš.
- **Polish Tatras video:** approved as an article, without Slovak map coordinates, and attached to the existing 29 October Dolina Suchej Kasprovej video bucket. The source identifies the same author and filming date.
- **Canadian attack:** rejected consistently with the two already rejected imports about the same Bella Coola case. Outside the local reporting scope.
- **Oravská Magura travel piece:** rejected as travel reportage without a specific new bear event in the accessible source.

## Saved article buckets

| Bucket | Event or notice date | New links | Total approved records |
| --- | --- | ---: | ---: |
| Stretnutie s medvedicou a dvomi mláďatami za kúpeľmi Brusno | 2026-11-09 | 1 | 1 |
| ŠOP upozorňuje na výskyt medveďa pri obci Čertižné | 2026-11-05 (approximate) | 4 | 4 |
| ŠOP upozorňuje na výskyt medveďa pri Medzibrode a Hronskej Dúbrave | 2026-11-02 (approximate) | 1 | 6 |
| Habura: nález uhynutej zveri a následné upozornenie na výskyt medveďa | 2026-10-29 | 1 | 8 |
| Turista natočil medveďa v Doline Suchej Kasprovej na poľskej strane Tatier | 2026-10-29 | 1 | 5 |
| Výskyt medveďa v lokalite Mútnik pri Liptovskom Mikuláši | 2026-10-27 (approximate) | 1 | 10 |
| Upozornenie na medveďa pri Hronskej Dúbrave a Trnavej Hore | 2026-09-28 (approximate) | 1 | 6 |
| ŠOP pripomína zvýšenú opatrnosť počas jesenného zberu kukurice | 2026-09-23 | 2 | 2 |
| Pravidelne tam vídavajú medvede. Láka ich skládka v Liptovskej Sielnici, obec nevidí riešenie | 2026-09-03 (approximate) | 1 | 2 |
| Mapa hlásení výskytu medveďa: aktualizácia k 20. augustu 2026 | 2026-08-20 (approximate) | 1 | 4 |
| Mimoriadna situácia pre medvede v 55 okresoch | 2026-07-15 (approximate) | 1 | 10 |
| Medveď zaútočil na muža v Závažnej Porube: Spôsobil mu ľahké zranenia | 2026-07-12 (approximate) | 1 | 24 |
| Spoločné upozornenie ŠOP pre Dúbravicu a Liptovský Ján | 2026-06-21 | 2 | 2 |
| AKTUÁLNE: Na Liptove opäť útočil medveď. Záchranári sa pre drsný terén nevedia dostať k zranenému | 2026-06-04 (approximate) | 1 | 18 |
| Májový výskyt a následný odchyt medvieďaťa v Beluši | 2026-05-26 | 2 | 2 |
| Historický rozhovor o medveďoch z roku 2014 – fotogaléria | 2014-07-03 | 2 | 2 |

## Other corrections and independent records

- Restored missing publisher dates for the bear-spray advice, Golem profile, autumn feeding article, and the changed-slug Liptovská Sielnica report.
- Corrected the Pluska 55-district gallery to the publisher’s 15 July timestamp. Corrected the reimported Aktuality gallery from an apparent 2026 date to its original 3 July 2014 date. It is grouped with the fourth photo from the same gallery.
- The four Čertižné articles cover the same official notice of 5 November; the actual observation date remains unknown, so the bucket date is approximate. The official notice is primary.
- Retained both locations in the Medzibrod/Hronská Dúbrava and September Hronská Dúbrava/Trnavá Hora warnings.
- The new Dúbravica/Liptovský Ján bucket represents one combined bulletin about two locations. The Beluša bucket covers the same May cub sighting and subsequent capture. Their approved article category was retained and stale article coordinate hints were cleared.
- General advice, distinct map editions, separate observations and uncertain matches remain independent. Several SME sources were inaccessible; no attachment was inferred from their headlines alone.
- The two Ľubietová tumedved submissions have similar descriptions and times but substantially different coordinates. Only the exact matching cross-source pair was grouped. Separate Dobroč bear and Detvianska Huta droppings reports were retained independently.

## Sighting buckets

Brusno, Korytárky, Vrch Dobroč, Čertižné, Heľpa, Ľubietová (the matching coordinate pair), Veľké Rovné, and Žiar cemetery. Each contains two matching source records. Saved through the existing transactional `apply_sighting_bucket_plan` RPC.

## Verification and recovery

Database read-back assertions verified all approvals/rejections, 23 new article links, six new incidents, eight sighting buckets, all 16 sighting memberships, and every primary sighting record. All pre-existing links and original source-row IDs were retained.

Rebuilt the public snapshot successfully: revision **2489**, built revision **2489**, day **2026-11-11**. Live `/api/news` and `/api/warnings` both returned HTTP 200 with **209 news entries** and **589 warnings**. Eleven touched article buckets fall within the current limited feed selection; their complete coverage lists and counts were verified. Five older article-only buckets are saved in the database but fall outside that selection. All eight new sighting buckets were verified in the live response. The Polish video has no map coordinates and both rejected items are absent.

Recovery files: `C:/Users/matej/AppData/Local/Temp/medved-review-2026-11-11/` contains `before.json`, `sources.json`, `older-sources.json`, `counterpart-sources.json`, `plan.json`, `after.json`, `verification.json`, and the two live API responses. Database audit actor: `codex:content-review:2026-11-11`.

No application code or deployment was changed. Validation used source review, database assertions, snapshot publication and live API read-back.
