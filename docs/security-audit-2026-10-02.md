# Security and feature audit — 2 October 2026

Completed a source review, dependency audit, request-level regression tests and local browser checks. Fixes are in the working tree and have not been deployed. Existing changes to feedback delivery in `server.js` and `public/home.js` were preserved.

## Findings and fixes

| Finding | Impact | Fix |
| --- | --- | --- |
| Scraped news entered the public memory cache before persistence and moderation filtering | High: unapproved articles could be visible during refresh and remain visible after save/reload failure | Publish only the filtered database result; preserve previously approved data on failure |
| Public reports had no request quota or field bounds | Abuse of storage, notification delivery and AI requests; invalid coordinates/dates and malformed fields | Five requests per IP per 15 minutes; typed, bounded text, single email address, Slovak coordinates and valid observation date |
| Admin login had no brute-force protection and accepted arbitrary authorization schemes | Unlimited password attempts and incorrect authentication parsing | Ten failed attempts per IP per 15 minutes, explicit Basic scheme and constant-time secret comparison |
| Admin passwords containing colons or Unicode could not log in correctly | Valid credentials were truncated or browser encoding threw before error handling | Split at the first colon and encode browser credentials as UTF-8 |
| Malformed subscription area and poll choice objects could throw outside error handling | Express 4 async handlers could reject without responding and terminate the process | Type-check before trimming or property lookup; HTTP regressions verify the server remains available |
| Article requests followed arbitrary destinations and redirects | Server requests could reach private networks or cloud metadata endpoints; oversized HTML could exhaust resources | Validate public DNS/IP destinations at every redirect; pin the validated address to the connection; reject credentials/nonstandard ports; bound compressed and decoded bodies to 2 MiB |
| Cached data could stay stale indefinitely on another application instance | Moderation or scraper changes made elsewhere did not reach existing visitors | Reload database-backed stores on reads after 60 seconds |
| Report submission returned success when storage was unconfigured | Users were told an unsaved report had been accepted | Return 503 when storage is unavailable; require a saved record ID before success |
| A failed email outbox claim marked its digest slot complete | A temporary database failure suppressed retry for the rest of the scheduled window | Mark a slot complete only after its worker finishes successfully |
| Admin writes lacked an explicit cross-origin guard; sensitive responses lacked cache restrictions | Cross-site requests and accidental caching of admin data or signed email-action pages | Origin/fetch-metadata check on admin writes, `no-store`, `no-referrer`, and anti-framing headers; redirect `/admin.html` to `/admin` |
| Public tile requests accepted unbounded coordinates and had no upstream timeout | Invalid requests could consume upstream resources and hang | Validate zoom/tile bounds and enforce a 10-second request timeout |
| Six dependency packages had reported vulnerabilities, including three high severity | Known vulnerabilities in Express/qs/body-parser, Nodemailer, brace-expansion and Sharp | Updated Express to 4.22.3, Nodemailer to 10.0.13, Sharp to 0.35.5 and patched transitive dependencies; final npm audit reports zero |

The GitHub refresh workflow now sends its cron secret as a Bearer authorization header. Query-secret authentication remains compatible with existing external schedules. Proxy trust, when enabled, is limited to one hop. Email creation disables Nodemailer file and URL access.

## Validation

- `npm test`: **138 tests passed**, including moderation isolation, failed refreshes, authentication, malformed input, throttling, SSRF destinations/redirects, bounded response bodies and email retries.
- `npm run check`: syntax, inline JavaScript and SEO checks passed.
- `npm run check:browser`: 11 routes rendered without JavaScript exceptions or missing local assets; admin login with Unicode/colon credentials, mobile navigation and report validation passed.
- Real Nodemailer MIME generation passed using an in-memory transport. Sharp successfully encoded a source image to WebP and AVIF without changing assets.
- Read-only HTTPS transport checks returned HTTP 200 from example.com and news.google.com.
- Final `npm audit`: **0 vulnerabilities**, including development dependencies.
- Current tracked-file scan found no `.env` files or matches for the checked private-key, API-token and JWT patterns. This was not a complete Git-history secret scan.
- `git diff --check` passed.

## Deployment and scope

Use Node **20.9 or newer**; Node 24 was used for these checks. Commit the updated package manifest and lockfile together.

Live Supabase writes, actual SMTP/Telegram delivery, production scraping and deployment were not exercised. Browser checks used an isolated application with empty data and fixture map tiles. Existing SQL was reviewed for row-level security and restricted service-role RPC permissions, but production policies were not inspected.

Rate limits are bounded **per process**. A shared proxy/WAF or shared limiter is needed to enforce one global quota across serverless instances. `TRUST_PROXY=true` assumes one trusted proxy; confirm the deployment's forwarded-IP handling before relying on IP quotas. The CSP restricts framing, objects and base URLs; it is not a full script-source policy.
