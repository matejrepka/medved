import { pathToFileURL } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { chromium } from 'playwright';
import express from 'express';
import compression from 'compression';

const output = new URL('./', import.meta.url);
await mkdir(output, { recursive: true });
const fixturesFile = new URL('public-feeds.json', output);
let fixtures;
try { fixtures = JSON.parse(await readFile(fixturesFile, 'utf8')); }
catch {
  const feeds = await Promise.all(['warnings', 'news'].map(async name => {
    const response = await fetch(`https://kdejemedved.sk/api/${name}`);
    if (!response.ok) throw new Error(`${name}: ${response.status}`);
    return [name, await response.json()];
  }));
  fixtures = Object.fromEntries(feeds);
  await writeFile(fixturesFile, JSON.stringify(fixtures));
}
Object.assign(process.env, {
  SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', SMTP_HOST: '',
  EMAIL_ENABLED: 'false', TELEGRAM_ENABLED: 'false',
  DISABLE_WEBSITE_LOGS: 'true', DISABLE_STARTUP_REFRESH: 'true',
});
const { ScheduledDataStore } = await import('../../src/scheduled-store.js');
ScheduledDataStore.prototype.get = async function () {
  const feed = fixtures[this.name === 'sightings' ? 'warnings' : 'news'];
  this.value = feed.items;
  this.fetchedAt = new Date(feed.updatedAt).getTime();
  return this.value;
};
const { app } = await import('../../server.js');
const audited = express();
if (process.argv.includes('--built')) {
  audited.use(compression());
  const assets = express.static(new URL('../../dist-worker/public/', import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
  audited.use((req, res, next) => /\.(?:js|css)$/.test(req.path) ? assets(req, res, next) : next());
}
audited.use(app);
const server = audited.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
// Public tiles are cached on disk so repeated measurements use identical map imagery.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith('https://basemaps.cartocdn.com/')) {
    const upstream = new URL(url);
    const tileName = upstream.pathname.replace(/\//g, '_');
    const filename = new URL(`tile${tileName}`, output);
    try { return new Response(await readFile(filename), { headers: { 'content-type': 'image/png' } }); }
    catch {
      const response = await realFetch(url, options);
      if (response.ok) await writeFile(filename, Buffer.from(await response.clone().arrayBuffer()));
      return response;
    }
  }
  return realFetch(url, options);
};
const { default: lighthouse } = await import(pathToFileURL('C:/Users/matej/AppData/Local/npm-cache/_npx/ba16b138af87a83e/node_modules/lighthouse/core/index.js'));
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--remote-debugging-port=9222'] });
  const target = process.argv.includes('--live') ? 'https://kdejemedved.sk/' : origin;
  const label = process.argv[2] || 'local';
  const result = await lighthouse(target, {
    port: 9222, output: ['json', 'html'], logLevel: 'error',
    onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
    ...(process.argv.includes('--desktop') ? { formFactor: 'desktop', screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false } } : {}),
  });
  await writeFile(new URL(`${label}.json`, output), result.report[0]);
  await writeFile(new URL(`${label}.html`, output), result.report[1]);
  console.log(JSON.stringify({ url: target, scores: Object.fromEntries(Object.entries(result.lhr.categories).map(([k,v]) => [k, Math.round(v.score * 100)])), metrics: Object.fromEntries(['first-contentful-paint','largest-contentful-paint','total-blocking-time','cumulative-layout-shift','speed-index'].map(k => [k, result.lhr.audits[k].displayValue])), failures: Object.values(result.lhr.audits).filter(a => a.score !== null && a.score < 1 && a.scoreDisplayMode !== 'informative').map(a => ({id:a.id,title:a.title,value:a.displayValue})) }, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
