import fs from 'node:fs';
import { fetchDirectArticle } from '../../src/scrapers/article.js';
const dir = '.tmp/news-review-2026-10-12';
const snapshot = JSON.parse(fs.readFileSync(`${dir}/snapshot.json`));
const output = fs.existsSync(`${dir}/bodies.json`) ? JSON.parse(fs.readFileSync(`${dir}/bodies.json`)) : [];
let next = 0;
await Promise.all(Array.from({length:5}, async () => {
  while(next < snapshot.rows.length) {
    const index = next++;
    const row = snapshot.rows[index];
    if (output.some(item => item.id === row.id)) continue;
    if (row.published_at > '2026-10-12T23:59:59Z') continue;
    try {
      const result = await fetchDirectArticle(row.article_url || row.link, 18000);
      output.push({ index, id:row.id, title:row.title, ...result });
      console.log(JSON.stringify({index,length:result.body?.length||0,date:result.publishedAt}));
    } catch(error) {output.push({index,id:row.id,error:error.message});}
  }
}));
output.sort((a,b)=>a.index-b.index);
fs.writeFileSync(`${dir}/bodies.json`,JSON.stringify(output,null,2));
