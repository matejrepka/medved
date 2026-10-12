import 'dotenv/config';
import fs from 'node:fs';
import { getSupabase } from '../../src/db/supabase.js';
import { reviewNewsWithIncident, updateNewsFields } from '../../src/db/repository.js';
import { sourceTypePriority } from '../../src/incidents.js';
const dir='.tmp/news-review-2026-10-12';
const plan=JSON.parse(fs.readFileSync(`${dir}/plan.json`));
const snapshot=JSON.parse(fs.readFileSync(`${dir}/snapshot.json`));
const db=getSupabase();
const results=[];
const checked=await db.from('news_logs').select('*').in('id',[...plan.entries,...plan.cleanRejected].map(e=>e.id));
if(checked.error)throw checked.error;
for(const entry of [...plan.entries,...plan.cleanRejected]) {
  const current=checked.data.find(r=>r.id===entry.id);
  if(!current || current.status!==entry.expectedStatus || current.updated_at!==entry.expectedUpdatedAt)throw new Error(`Record changed since review: ${entry.index}`);
}
fs.writeFileSync(`${dir}/immediate-before.json`,JSON.stringify(checked.data,null,2));
const save=()=>fs.writeFileSync(`${dir}/applied.json`,JSON.stringify({groups:plan.groups,results},null,2));
for(const entry of plan.entries) {
  const group=entry.group?plan.groups[entry.group]:null;
  const primary=entry.locations[0]||{};
  const fields={status:'approved',category:entry.category,locations:entry.locations,place:primary.place,lat:primary.lat,lng:primary.lng,actor:plan.actor,sourceType:entry.sourceType,incidentAction:!group?'ungrouped':group.id?'attach':'create',incidentId:group?.id,eventDate:group?.date,eventDatePrecision:group?.precision,incidentLocality:group?.place,incidentLat:group?.lat,incidentLng:group?.lng,incidentTitle:group?.title,incidentSummary:group?.summary};
  let result;
  try {result=await reviewNewsWithIncident(entry.id,fields);}
  catch(error) {
    // Preserve historical duplicate rows and URL ownership. A duplicate already
    // in its reviewed group needs only field correction, not a new attachment.
    const before=snapshot.rows[entry.index];
    if(!/Rovnaká zdrojová URL/.test(error.message||'') || !group?.id || before.incident_id!==group.id || before.status!=='approved')throw error;
    await updateNewsFields(entry.id,{category:entry.category,locations:entry.locations});
    const changed=await db.from('incident_news_links').update({source_type:entry.sourceType,source_priority:sourceTypePriority(entry.sourceType),attached_by:plan.actor}).eq('news_id',entry.id).eq('incident_id',group.id);
    if(changed.error)throw changed.error;
    const audit=await db.from('news_incident_audit').insert({news_id:entry.id,incident_id:group.id,action:'article_attached',actor:plan.actor,details:{preservedDuplicateUrl:true,reviewedLocations:entry.locations}});
    if(audit.error)throw audit.error;
    result={status:'approved',incidentId:group.id,preservedDuplicateUrl:true};
  }
  if(group&&!group.id) {group.id=result.incidentId;if(!group.id)throw new Error(`Group creation failed: ${entry.group}`);}
  const loaded=await db.from('news_logs').select('payload,updated_at').eq('id',entry.id).single();
  if(loaded.error)throw loaded.error;
  const payload=loaded.data.payload||{};
  const classification=payload.aiClassification||{};
  const update={payload:{...payload,category:entry.category,locations:entry.locations,place:primary.place||null,lat:primary.lat??null,lng:primary.lng??null,hasCoords:Boolean(primary.hasCoords),...(entry.summary?{aiSummary:entry.summary}:{}),aiClassification:{...classification,category:entry.category,place:primary.place||null,places:entry.locations.map(l=>l.place),eventDate:entry.category==='warning'?entry.eventDate:null,eventDatePrecision:entry.category==='warning'?entry.precision:'unknown',eventDateConfidence:entry.precision==='day'?1:0,summaryGenerated:false,reviewedAt:new Date().toISOString(),reviewedBy:plan.actor},manualReview:{actor:plan.actor,reviewedAt:new Date().toISOString(),sourceUrl:snapshot.rows[entry.index].article_url||snapshot.rows[entry.index].link,group:entry.group,locations:entry.locations,datePrecision:entry.precision}},...(entry.publishedAt?{published_at:entry.publishedAt}:{})};
  const patched=await db.from('news_logs').update(update).eq('id',entry.id).eq('updated_at',loaded.data.updated_at).select('id');
  if(patched.error)throw patched.error;
  if(patched.data.length!==1)throw new Error(`Concurrent change during review: ${entry.index}`);
  results.push({index:entry.index,id:entry.id,...result});save();
  console.log(JSON.stringify({index:entry.index,status:'approved',group:entry.group,action:result.action||'preserved'}));
}
for(const entry of plan.cleanRejected) {
  await updateNewsFields(entry.id,{category:'article',locations:[]});
  const loaded=await db.from('news_logs').select('payload').eq('id',entry.id).single();
  if(loaded.error)throw loaded.error;
  const payload=loaded.data.payload||{};
  const updated=await db.from('news_logs').update({payload:{...payload,category:'article',place:null,lat:null,lng:null,hasCoords:false,locations:[],aiClassification:{...(payload.aiClassification||{}),category:'article',place:null,places:[]},manualReview:{actor:plan.actor,reason:'Foreign news: remove erroneous Slovak map location; rejection preserved'}}}).eq('id',entry.id).eq('status','rejected').select('id');
  if(updated.error)throw updated.error;
  if(updated.data.length!==1)throw new Error(`Rejected status changed: ${entry.index}`);
  results.push({index:entry.index,id:entry.id,status:'rejected',locationCleared:true});save();
}
for(const [name,group] of Object.entries(plan.groups)) {
  const result=await db.from('news_incidents').update({event_date:group.date,event_date_precision:group.precision,locality:group.place,lat:group.lat,lng:group.lng,title:group.title,summary:group.summary,updated_at:new Date().toISOString()}).eq('id',group.id).select('id');
  if(result.error)throw result.error;
  if(result.data.length!==1)throw new Error(`Group metadata not updated: ${name}`);
  const refresh=await db.rpc('refresh_news_incident_primary',{p_incident_id:group.id});
  if(refresh.error)throw refresh.error;
}
save();
console.log(JSON.stringify({complete:true,approvedPending:plan.entries.filter(e=>e.expectedStatus==='pending').length,reviewed:plan.entries.length,groups:Object.keys(plan.groups).length,cleanedRejected:plan.cleanRejected.length}));
