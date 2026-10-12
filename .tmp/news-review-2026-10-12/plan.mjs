import fs from 'node:fs';
import { normalizeNewsLocations } from '../../src/news-locations.js';
import { TOURIST_PLACES } from '../../src/geo/tourist-places.js';
const dir = '.tmp/news-review-2026-10-12';
const snapshot = JSON.parse(fs.readFileSync(`${dir}/snapshot.json`));
const bodies = JSON.parse(fs.readFileSync(`${dir}/bodies.json`));
const gazetteer = JSON.parse(fs.readFileSync('src/geo/sk-places.json'));
const geo = JSON.parse(fs.readFileSync(`${dir}/geocoding.json`));
const locality = name => {
  const result = gazetteer.find(p => p.name === name);
  if (!result) throw new Error(`Missing locality: ${name}`);
  return {place:name,lat:result.lat,lng:result.lng};
};
const route = {place:'Kláštorská cesta',lat:TOURIST_PLACES[0].lat,lng:TOURIST_PLACES[0].lng};
const klastorisko = snapshot.rows[16].locations[0];
const vartovkaResult = geo['Vartovka, Banská Bystrica'].find(p=>p.name==='Vartovka');
const vartovka = {place:'Urpín – Vartovka',lat:vartovkaResult.lat,lng:vartovkaResult.lng};
const ilanovo = snapshot.rows[36].locations.find(l=>l.place==='Iľanovo');
const liptov = [locality('Svätý Kríž'),locality('Závažná Poruba'),ilanovo,vartovka];
const mysla = [locality('Vyšná Myšľa')];
const hronska = [locality('Hronská Dúbrava'),locality('Trnavá Hora')];
const groups = {
  raj:{id:'c0386434-1947-4d06-98c3-777df42eda72',date:'2026-10-07',precision:'day',...route,title:'Stret medveďa s bežcom na Kláštorskej ceste v Slovenskom raji',summary:'Dňa 7. októbra 2026 medveď poranil bežca na Kláštorskej ceste medzi Podleskom a Kláštoriskom, približne kilometer nad Podleskom. Muža ošetrili v nemocnici a lokalitu monitoruje zásahový tím. Súradnice označujú orientačný bod na trase, presné miesto stretu nebolo zverejnené.'},
  liptov:{id:'5cd6e642-ff91-4e93-ad42-cf094916bbf2',date:'2026-10-04',precision:'approximate',...liptov[0],title:'Víkendové hlásenia medveďa: Svätý Kríž, Závažná Poruba, Iľanovo a Urpín – Vartovka',summary:'ŠOP SR 5. októbra upozornila na víkendové hlásenia z okolia Svätého Kríža, Závažnej Poruby a Iľanova a z lokality Urpín – Vartovka pri Banskej Bystrici. Oblasti monitorujú zásahové tímy NAPANT a STRED. Ide o spoločné upozornenie na viac lokalít, nie o jeden útok.'},
  mysla:{id:'6fb23f8b-abb0-4ba1-aecc-9a3fd3f36643',date:'2026-10-07',precision:'day',...mysla[0],title:'Medvedica s mláďatami pri Vyšnej Myšli',summary:'V stredu ráno 7. októbra 2026 spozorovali medvedicu s mláďatami pri výjazde z Vyšnej Myšle smerom na Košice. Košická krajská polícia vyzvala ľudí na zvýšenú opatrnosť a informovala zásahový tím. V tejto správe sa neuvádza útok na človeka.'},
  zmos:{id:null,date:'2026-10-07',precision:'day',place:'Mošovce',lat:null,lng:null,title:'ZMOS po brífingu v Mošovciach žiada zmenu manažmentu medveďa hnedého',summary:'ZMOS na brífingu v Mošovciach 7. októbra 2026 žiadal vládu o zmeny manažmentu medveďa hnedého a európskych pravidiel jeho ochrany. Samosprávy upozornili na problémy v Turci a na Liptove. Ide o správy o stanovisku samospráv, nie o nové miestne pozorovanie medveďa.'},
  map1:{id:'ac48fbf2-fa8c-4fde-beb2-26ad26774c93',date:'2026-10-01',precision:'day',place:'Slovensko',lat:null,lng:null,title:'Mapa hlásení výskytu medveďa: aktualizácia k 1. októbru 2026',summary:'ŠOP SR zverejnila mapu hlásení výskytu medveďa hnedého na Slovensku k 1. októbru 2026. Údaje sumarizujú podnety verejnosti podľa okresov, nevyjadrujú počet jednotlivých medveďov a neurčujú presné miesto nového pozorovania.'},
  map24:{id:'e623d959-7433-4683-9a58-f2ed488a1f47',date:'2026-09-24',precision:'day',place:'Slovensko',lat:null,lng:null,title:'Mapa hlásení výskytu medveďa: aktualizácia k 24. septembru 2026',summary:'Mapa ŠOP SR sumarizuje hlásenia výskytu medveďa hnedého na Slovensku od začiatku roka do 24. septembra 2026. Bola zverejnená 25. septembra. Počty hlásení podľa okresov nie sú počtami jedincov ani presnými bodmi aktuálneho výskytu.'},
  map28:{id:null,date:'2026-09-28',precision:'day',place:'Slovensko',lat:null,lng:null,title:'Mapa hlásení výskytu medveďa: aktualizácia k 28. septembru 2026',summary:'ŠOP SR zverejnila samostatnú aktualizáciu mapy hlásení výskytu medveďa hnedého k 28. septembru 2026. Mapa vychádza z podnetov verejnosti a ukazuje hlásenia podľa okresov, nie počty medveďov ani presné body nových incidentov.'},
  map8:{id:null,date:'2026-10-08',precision:'day',place:'Slovensko',lat:null,lng:null,title:'Mapa hlásení výskytu medveďa: aktualizácia k 8. októbru 2026',summary:'ŠOP SR zverejnila samostatnú aktualizáciu mapy hlásení výskytu medveďa hnedého k 8. októbru 2026. Údaje z podnetov verejnosti poskytujú orientačný prehľad výskytu podľa okresov a nepredstavujú počet jednotlivých zvierat.'},
  kremnica:{id:'4f9ace5c-8f6e-4a41-a0d7-82e233399c90',date:'2026-10-03',precision:'day',place:'Nová dolina',lat:48.716378,lng:18.9075803,title:'Možný výskyt medveďa v Novej doline a na Ludovike v Kremnici',summary:'Obyvateľka Kremnice uviedla, že 3. októbra večer počula v Novej doline ručanie pripisované medveďovi. Podobný zvuk zaznel deň predtým na Ludovike. Pozorovanie nie je potvrdené a článok upozorňuje aj na jeleniu ruju. Osobitne pripomína upozornenie ŠOP na Urpín – Vartovku.'},
  kamenista:{id:'19455e49-179b-4e5e-88ca-5ccff961c299',date:'2026-10-05',precision:'approximate',...snapshot.rows[32].locations[0],title:'Medvedica s dvoma mláďatami v Kamenistej doline',summary:'Turisti v Kamenistej doline v Západných Tatrách zachytili medvedicu s dvoma mláďatami z bezpečnej vzdialenosti. Zvieratá sa k turistom nepribližovali a článok neuvádza zranenia. Presný dátum stretnutia nebol zverejnený; dátum skupiny je orientačný.'},
  hronska:{id:'dafa02ee-d612-4bf2-802b-9dab6e807a8e',date:'2026-09-28',precision:'approximate',...hronska[0],title:'Upozornenie na medveďa pri Hronskej Dúbrave a Trnavej Hore',summary:'ŠOP SR upozornila na výskyt medveďa hnedého v okolí Hronskej Dúbravy a Trnavej Hory v okrese Žiar nad Hronom. Situáciu monitoruje Zásahový tím ŠOP SR STRED. Správy z 28. a 29. septembra nadväzujú na rovnaké upozornenie; presný deň pozorovaní sa neuvádza.'},
};
const entries=[];
function add(indices,group,category,locations,sourceType='syndication') {
  for(const index of indices) {
    const row=snapshot.rows[index];
    const resolved=typeof locations==='function'?locations(index):locations;
    entries.push({index,id:row.id,expectedStatus:row.status,expectedUpdatedAt:row.updated_at,status:'approved',category,locations:normalizeNewsLocations(resolved),group,sourceType,publishedAt:!row.published_at?bodies.find(b=>b.id===row.id)?.publishedAt:null});
  }
}
add([9,10,13,14,15,17,18,19,20,21,26,55,57,61],'raj','warning',[route]);
add([28,54],'raj','warning',[route],'national');
add([16],'raj','warning',[klastorisko],'official_notice');
add([30,31,35,37,56,62],'liptov','warning',liptov);
add([36],'liptov','warning',liptov,'official_notice');
add([22,23,27],'mysla','warning',mysla);
add([3],'zmos','article',[],'national');
add([11,12],'zmos','article',[],'local_original');
add([24,25],'zmos','article',[]);
add([33,40,41,42,59],'map1','article',[], 'national');
add([45],'map1','article',[],'official_notice');
add([47],'map24','article',[],'national');
add([48],'map28','article',[],'official_notice');
add([7],'map8','article',[],'official_notice');
add([34],'kremnica','warning',[snapshot.rows[34].locations[0],{place:'Ludovika, Kremnica',lat:48.7116994,lng:18.9000908},vartovka],'local_original');
add([32],'kamenista','warning',snapshot.rows[32].locations,'local_original');
add([49,51,53],'hronska','warning',hronska);
add([63],'hronska','warning',hronska,'national');
add([4],null,'article',[],'national');
add([5],null,'warning',[...mysla,locality('Nižný Klátov'),locality('Vyšný Klátov')],'national');
const active=snapshot.rows.filter(r=>r.status!=='rejected');
if(entries.length!==active.length || new Set(entries.map(e=>e.id)).size!==active.length)throw new Error('Plan does not cover exactly all approved and pending items');
const summaryOverrides={
  4:'Článok vysvetľuje možné príčiny stretov ľudí s medveďmi vrátane dostupnej potravy a jesennej aktivity. Prináša širšiu diskusiu o prevencii a regulácii; neoznamuje nové miestne pozorovanie.',
  5:'Vodiči spozorovali medvedicu s mláďatami pri Vyšnej Myšli. Článok uvádza aj pozorovanie medzi Nižným a Vyšným Klátovom a ako samostatný kontext pripomína stret s bežcom v Slovenskom raji. Presný dátum pozorovaní pri obciach nie je uvedený.',
};
for(const entry of entries) {
  entry.summary=summaryOverrides[entry.index]||groups[entry.group]?.summary;
  entry.eventDate=entry.group?groups[entry.group].date:null;
  entry.precision=entry.group?groups[entry.group].precision:'unknown';
}
const cleanRejected=[38,46].map(index=>({index,id:snapshot.rows[index].id,expectedStatus:'rejected',expectedUpdatedAt:snapshot.rows[index].updated_at,category:'article',locations:[]}));
const plan={window:{from:'2026-09-28',to:'2026-10-12'},actor:'reviewed-news:2026-10-12',groups,entries:entries.sort((a,b)=>a.index-b.index),cleanRejected};
fs.writeFileSync(`${dir}/plan.json`,JSON.stringify(plan,null,2));
console.log(JSON.stringify({reviewed:active.length,pending:entries.filter(e=>e.expectedStatus==='pending').length,groupCounts:entries.reduce((a,e)=>(a[e.group||'standalone']=(a[e.group||'standalone']||0)+1,a),{}),categoryCorrections:entries.filter(e=>e.category!==snapshot.rows[e.index].category).map(e=>e.index),locationCorrections:entries.filter(e=>JSON.stringify(e.locations)!==JSON.stringify(snapshot.rows[e.index].locations)).map(e=>e.index)},null,2));
