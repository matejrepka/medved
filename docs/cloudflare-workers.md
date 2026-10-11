# Cloudflare Workers deployment

This project deploys both its Express backend and browser assets as one Worker.
Uploading only `public/` creates a static site: `/api/status`, map tiles and
database-backed endpoints will return 404 regardless of environment variables.

## Update the existing Worker

Use Node.js 24 for the deployment tools. From the repository directory:

```sh
npm ci
npm run check:worker
npx wrangler login
npm run deploy
```

The production request logs identify the existing Worker as `medved`.
`wrangler.jsonc` targets that exact name. Deploying to the existing Worker keeps
the website connected to the same custom domain and secret bindings.
Do not put this site's runtime secrets on a separate Worker named `kdejemedved`.

For a Git-connected Cloudflare Workers build, use the repository root, install
dependencies including dev dependencies, and set the deploy command to
`npm run deploy`. Wrangler runs `npm run build:worker` automatically. Commit and
push the configuration, Workers source, scripts, package manifest and lockfile.
Do not deploy with an assets-only command such as `wrangler deploy --assets public`.

The configuration uses `keep_vars: true` to preserve dashboard variables. Store
the following production values in **medved → Settings → Variables
and Secrets → Production**, then deploy:

| Name | Purpose |
| --- | --- |
| `CARTO_BASEMAPS_API_KEY` | Standard light/dark basemap tiles |
| `SUPABASE_URL` | Existing Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only database access; store as a secret |
| `ADMIN_PASSWORD` | Admin API authentication; store as a secret |
| `SITE_URL` | `https://www.kdejemedved.sk` |

Keep the existing optional OpenRouter, Telegram, SMTP, newsletter and logging
configuration. None of these values is embedded in the frontend or the build.
Runtime bindings populate `process.env` through the explicit compatibility flag.
The map key, Supabase credentials, admin password and cron secret are read directly
from the current Worker's request bindings. This prevents a reused code instance
from retaining empty or old values after a secret-only update.

## Verify the deployed version

- `/api/status` must return HTTP 200 and JSON with `mapTilesConfigured: true` and
  `supabaseConfigured: true`. These fields only report presence; they do not reveal
  secret values or validate the upstream credentials.
- `/api/map-tiles/dark_all/0/0/0.png` must return HTTP 200 and a PNG.
- `/api/warnings` and `/api/news` must return JSON containing `items` arrays.
- `/vendor/leaflet/leaflet.js` and the local font URLs must return HTTP 200.

A tile response of 503 means `CARTO_BASEMAPS_API_KEY` is missing; 502 means the
upstream tile request failed. A 404 still means the API Worker is not serving the
domain. `npx wrangler tail --name medved` shows runtime errors
without putting production secrets in this repository.

## Data refresh and notifications

Keep `.github/workflows/refresh.yml` enabled and configured with its existing
GitHub secrets. It runs the Node scraper with Chromium and stores new records in
Supabase. The Worker reads approved records from the same database. Chromium's
local browser fallback is excluded from the Worker bundle; Cloudflare Workers
cannot launch this Node application's local Chromium executable.

A five-minute Cloudflare Cron Trigger drains the durable Telegram/email queues;
email digests retain their configured Bratislava delivery windows. Workers does
not start Node polling timers. SMTP connections are opened per delivery rather
than pooled across requests. Use port 587 or 465 for SMTP, since Workers blocks
outbound port 25. Production SMTP/Telegram deliveries are not exercised by the
local fixture checks.

## Local development

`npm run dev` keeps the existing Node server. `npm run dev:worker` starts Wrangler
with the Worker build. Local `.env` or `.dev.vars` can supply development bindings;
these files are ignored by Git. `npm run check:worker` uses isolated fake secrets,
mock database and tile responses, and Cloudflare's local runtime. It never reads
production `.env` values or sends messages to real subscribers.
