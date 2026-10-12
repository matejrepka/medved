import 'dotenv/config';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {getSupabase} from '../../src/db/supabase.js';
import {loadAllNews,loadNewsLogs} from '../../src/db/repository.js';
const dir='.tmp/news-review-2026-10-12';
const plan=JSON.parse(fs.readFileSync(`${dir}/plan.json`));
const applied=JSON.parse(fs.readFileSync(`${dir}/applied.json`));
const before=JSON.parse(fs.readFileSync(`${dir}/immediate-before.json`));
const db=getSupabase();
const ids=before.map(r=>r.id);
const checks=await Promise.all([
  db.from('news_logs').select('*').in('id',ids),
  db.from('news_warning_locations').select('*').in('news_id',ids).order('position'),
  db.from('incident_news_links').select('*').in('news_id',ids),
  db.from('news_incidents').select('*').in('id',Object.values(applied.groups).map(g=>g.id)),
  db.from('news_logs').select('id').eq('status','pending'),
]);
for(const check of checks)if(check.error)throw check.error;
const [raw,locations,links,incidents,pending]=checks.map(c=>c.data);
const admin=await loadAllNews({limit:2000});
const publicRows=await loadNewsLogs();
for(const entry of plan.entries) {
  const row=raw.find(r=>r.id===entry.id);
  const previous=before.find(r=>r.id===entry.id);
  const adminRow=admin.find(r=>r.id===entry.id);
  assert.equal(row.status,'approved');assert.equal(row.category,entry.category);
  for(const field of ['title','source','snippet','link','article_url','google_news_url','scraped_at'])assert.deepEqual(row[field],previous[field],`${entry.index}: preserved ${field}`);
  const simplify=items=>items.map(({place,lat,lng})=>({place,lat,lng}));
  assert.deepEqual(simplify(adminRow.locations),simplify(entry.locations),`${entry.index}: admin locations`);
  assert.deepEqual(simplify(locations.filter(l=>l.news_id===entry.id)),simplify(entry.locations),`${entry.index}: stored locations`);
  const primary=entry.locations[0]||{};
  assert.equal(row.place,primary.place||null);assert.equal(row.lat,primary.lat??null);assert.equal(row.lng,primary.lng??null);
  if(entry.category==='article')assert.equal(row.has_coords,false);
  const link=links.find(l=>l.news_id===entry.id);
  assert.equal(link?.incident_id||null,entry.group?applied.groups[entry.group].id:null,`${entry.index}: group`);
  if(link)assert.equal(link.source_type,entry.sourceType);
  if(entry.publishedAt)assert.equal(new Date(row.published_at).toISOString(),new Date(entry.publishedAt).toISOString());
}
for(const entry of plan.cleanRejected) {
  const row=raw.find(r=>r.id===entry.id);
  assert.equal(row.status,'rejected');assert.equal(row.place,null);assert.equal(row.lat,null);assert.equal(row.lng,null);
  assert.deepEqual(admin.find(r=>r.id===entry.id).locations,[]);
}
assert.equal(pending.length,0,'Pending queue empty');
for(const [name,group] of Object.entries(applied.groups)) {
  const incident=incidents.find(i=>i.id===group.id);
  assert.equal(incident.locality,group.place);assert.equal(incident.lat,group.lat);assert.equal(incident.lng,group.lng);assert.equal(incident.event_date,group.date);
  const card=publicRows.find(r=>r.incidentId===group.id);assert.ok(card,`${name}: public card`);
  const expected=plan.entries.filter(e=>e.group===name);
  for(const entry of expected)assert.ok(card.coverage.some(c=>c.id===entry.id),`${entry.index}: public coverage retained`);
  if(name.startsWith('map')||name==='zmos')assert.equal(card.category,'article',`${name}: no warning marker`);
  if(name==='raj'){assert.equal(card.sourceCount,17);assert.equal(card.place,'Kláštorská cesta');assert.equal(card.verificationStatus,'official_notice');}
  if(name==='mysla')assert.equal(card.verificationStatus,'reported');
}
const stats={reviewed:plan.entries.length,approved:plan.entries.filter(e=>e.expectedStatus==='pending').length,pending:pending.length,locationCorrections:plan.entries.filter(e=>{
  const previous=before.find(r=>r.id===e.id);return previous.place!==(e.locations[0]?.place||null)||JSON.stringify(previous.payload?.locations||[])!==JSON.stringify(e.locations);
}).length,categoryCorrections:plan.entries.filter(e=>before.find(r=>r.id===e.id).category!==e.category).length,clusterChanges:plan.entries.filter(e=>{
  const original=JSON.parse(fs.readFileSync(`${dir}/snapshot.json`)).rows[e.index];return original.incident_id!==(e.group?applied.groups[e.group].id:null);
}).length,publicationDatesRestored:plan.entries.filter(e=>e.publishedAt).length,groups:Object.keys(applied.groups).length};
fs.writeFileSync(`${dir}/verified.json`,JSON.stringify({stats,rows:raw,locations,links,incidents,publicCards:publicRows.filter(r=>Object.values(applied.groups).some(g=>g.id===r.incidentId))},null,2));
console.log(JSON.stringify({verified:true,...stats},null,2));
try {
  const api=await fetch('https://kdejemedved.sk/api/news');
  const live=await api.json();
  if(!api.ok)throw new Error(`HTTP ${api.status}`);
  const raj=live.items.find(r=>r.incidentId===applied.groups.raj.id);
  const standalone=live.items.find(r=>r.id===plan.entries.find(e=>e.index===5).id);
  console.log(JSON.stringify({liveApi:true,rajSources:raj?.sourceCount,rajPlace:raj?.place,stvrLocations:standalone?.locations?.map(l=>l.place)}));
  fs.writeFileSync(`${dir}/live-api.json`,JSON.stringify(live,null,2));
}catch(error){console.log(JSON.stringify({liveApi:false,error:error.message}));}
