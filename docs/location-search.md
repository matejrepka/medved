# Vyhľadávanie a lokalizácia turistických miest

Administrácia a AI lokalizácia článkov používajú spoločné vyhľadávanie v
`src/geo/search.js`. Automatické určenie obce vyžaduje úplnú zhodu názvu:
napríklad Suchá Belá sa nesmie lokalizovať ako obec Suchá. AI zachová pomenované
trasy, rokliny a rázcestia a pri nejednoznačnom názve pridá región z článku.

Vyhľadávanie najprv overí miestny turistický register a Nominatim. Ak Nominatim
nenájde úplnú zhodu, Overpass dohľadá pomenované OSM uzly, cesty a relácie podľa
`name`, `name:sk`, `alt_name`, `loc_name`, `official_name` a pri turistických,
peších a cyklistických trasách aj `description`. Podporuje názvy bez diakritiky.
Región za čiarkou alebo po „v“/„vo“ obmedzí dohľadávanie na jeho mapové hranice.
Overpass vždy filtruje územie Slovenska. Požiadavky sú explicitné, cachované a
serializované; Nominatim má odstup aspoň jednej sekundy. Chyba poskytovateľa sa
nesmie uložiť ako úspešné prázdne vyhľadávanie.
Pri preťažení alebo výpadku hlavného Overpass servera sa skúsi záložná inštancia.

Pri trase je značka orientačným bodom na skutočnej geometrii trasy. Výsledok
vyhľadávania to uvádza v popise. Neurčuje presné miesto incidentu, ak ho článok
neuvádza. Ďalšie lokality musia byť pomenované v OSM alebo pridané do overeného
registra; súradnice sa neodhadujú podľa podobného názvu obce.

## Kláštorská cesta

Miestny názov doložený v [článku o incidente](https://www.kosicak.sk/clanky/14466/vo-vyhladavanej-turistickej-lokalite-v-slovenskom-raji-poranil-medved-bezca-po-selme-patra-zasahovy-tim)
Nominatim neindexuje. `tourist-places.js` preto uchováva názov aj pádové tvary a
orientačný bod **48.9526744, 20.3988546** na žltom úseku Nad Podleskom – Pod
Kláštoriskom, ktorý je súčasťou spojenia Podlesok – Kláštorisko. Tento úsek
eviduje [správa národného parku](https://www.npslovenskyraj.sk/turistika/)
ako trasu 8886; geometriu poskytuje [OSM relácia 1706003](https://www.openstreetmap.org/relation/1706003),
cesta 66919768. Overené 12. 10. 2026. Nejde o Kláštorskú roklinu.

Lokálne geokódovanie importovaných článkov rozpozná napríklad „na Kláštorskej
ceste“ pri zmienke o výskyte a uprednostní trasu pred obcou Hrabušice uvedenou
ako zdroj varovania. Zmena sa uplatní pri novom vyhľadávaní a novom importe;
staršie schválené záznamy automaticky neprepisuje.
