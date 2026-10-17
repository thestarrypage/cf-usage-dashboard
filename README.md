# Cloudflare Usage Dashboard

A self-hosted dashboard for your Cloudflare account's usage, running as a single Cloudflare
Worker. Pick any date range (say Sep 1 – Sep 30) and see CDN, Bot Management, DNS, Spectrum,
Images, developer-platform and Zero Trust usage side by side, drill into any zone, set monthly
caps, and get alerted (Slack, Discord, Teams, Google Chat, ntfy or any webhook) before you hit them.

It reads Cloudflare's [GraphQL Analytics API](https://developers.cloudflare.com/analytics/graphql-api/)
with a read-only API token. Nothing leaves your account except the alerts you configure.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/iamjjchang/cloudflare-usage-dashboard)

## What it shows

| Product | Metrics | Source |
|---|---|---|
| CDN (per zone) | Requests, data transfer, cache share | `httpRequests1dGroups` (exact) |
| Bot Management (per zone) | Good requests = requests − threats | `httpRequests1dGroups` (exact) |
| DNS (per zone) | DNS queries, NOERROR / NXDOMAIN share | `dnsAnalyticsAdaptiveGroups` |
| Spectrum (per zone) | IPv4 addresses, data in/out, connections, concurrent now | REST `/spectrum/apps`, `/spectrum/analytics/*` |
| Images | Unique transformations per month (billable) and per day | `imagesUniqueTransformations*` |
| Workers | Requests, CPU time, errors, subrequests, per Worker | `workersInvocationsAdaptive` |
| Workers KV | Reads, writes, deletes, lists, storage, keys | `kvOperationsAdaptiveGroups`, `kvStorageAdaptiveGroups` |
| D1 | Rows read/written, queries, storage | `d1AnalyticsAdaptiveGroups`, `d1StorageAdaptiveGroups` |
| Durable Objects | Requests, duration (GB-s), CPU, SQL rows, storage | `durableObjects*` |
| Containers | vCPU-s, memory GiB-s, disk GB-s, egress | `containersUsageAdaptiveGroups` |
| Queues | Billable operations | `queueMessageOperationsAdaptiveGroups` |
| Workflows | Instances, steps, CPU, duration | `workflowsAdaptiveGroups` |
| Pages Functions | Requests, errors, duration | `pagesFunctionsInvocationsAdaptiveGroups` |
| R2 | Class A / B operations, storage by class, bandwidth | `r2*AdaptiveGroups` |

**Zone drill-down** – click any zone name for that zone's detail:

- Daily charts: requests per day (good vs threats), data transfer per day, DNS queries per day
- CDN: top countries, status codes, content types (exact); cache status, top hostnames, top paths, device types (sampled)
- Bot Management: decision (automated / likely human / verified bot), bot score distribution, detection engine, verified bot categories, security actions
- DNS: query types, response codes, top query names, protocol & IP version, cached answers, top data centers
- Daily table and CSV export

**Zero Trust page** – every Cloudflare One analytics dataset for the selected dates:

| Area | What you see | Datasets |
|---|---|---|
| Access | Logins, unique users, denied logins, login requests; by application, identity provider, login type, country | `cf1AccessLogins1dGroups`, `accessLoginRequestsAdaptiveGroups` |
| Gateway DNS | Queries, bytes, users, devices; by resolver decision, query type, response code, location, policy, country | `cf1GatewayDns1dGroups` |
| Gateway HTTP | Requests, data, users, applications, DLP scans/matches, antivirus and sandbox results, isolated requests, MCP URLs; by action, host, country | `cf1GatewayHttp1dGroups` |
| Gateway network | L4 firewall events, sessions, users, devices; by action, transport, SNI, rule, destination country | `cf1GatewayNetwork1dGroups` |
| Proxied sessions | Sessions, bytes up/down, TCP handshake time; by protocol, egress IP, on-ramp, close reason | `cf1GatewayNetworkSession1dGroups` |
| Shadow IT / MCP | Applications seen and their approval status, MCP servers used by AI agents | `shadowIt1hGroups`, `cf1McpHost1dGroups` |
| WARP / Tunnel / Isolation | Devices by platform, version, status, mode; Tunnel traffic by device; Browser Isolation sessions and user actions | `warpDeviceAdaptiveGroups`, `cloudflareTunnelsAnalyticsAdaptiveGroups`, `browserIsolation*` |
| Private networks & more | Private network discovery, plus a status table for every remaining sampled dataset (resolver, L4/L7 detail, Privacy Proxy, sinkhole) | `zeroTrustPrivateNetworkDiscoveryGroups` and others |

Products with no activity in the range collapse into a single line, so the page stays readable.

**Date picker** – presets (last 7/14/30/90 days, this month, last month…) plus a calendar: click a
start date, then an end date. Works the same on every page.

**Caps & alerts** – set a monthly cap for any of 35 billable metrics and two thresholds with
sliders (default: warning 80%, critical 90%).

- The overview shows a progress bar under each capped metric and a banner when any is close.
- Every hour the Worker checks month-to-date usage and alerts your webhook when a metric reaches
  warning, critical, or goes over its cap – once per metric per level per month.
- Webhook format is detected automatically: [ntfy](https://ntfy.sh) servers get a native ntfy
  notification (title, priority, tags); everything else gets JSON with `text` (Slack, Teams,
  Google Chat), `content` (Discord) and a structured `alerts` array.

**Also:** date picker with presets and absolute ranges, Enterprise-only or all zones, CSV export,
shareable URLs (`?from=2026-09-01&to=2026-09-30`), light and dark mode. All dates are UTC.

## Deploy

### Option 1 – Deploy to Cloudflare button

Click the button above. Cloudflare copies the repo to your GitHub/GitLab account, creates the KV
namespace, asks for the two secrets, and deploys. Every push to your copy redeploys it.

### Option 2 – one command

Requires Node.js 18+.

```bash
git clone https://github.com/iamjjchang/cloudflare-usage-dashboard.git
cd cloudflare-usage-dashboard
npm install
npm run setup
```

`npm run setup` signs you in to Cloudflare (browser), deploys the Worker (creating the `CAPS` KV
namespace on the first run), and prompts for the two secrets. It prints your `workers.dev` URL;
open it and sign in with any username and your dashboard password.

### Option 3 – step by step

```bash
npm install
npx wrangler login
npx wrangler deploy                          # first deploy creates the CAPS KV namespace
npx wrangler secret put CF_API_TOKEN
npx wrangler secret put DASHBOARD_PASSWORD
```

## API token

Create a token at **My Profile → API Tokens → Create Token → Custom token** (or an
account-owned token under **Manage Account → Account API Tokens**) with:

| Permission | Why |
|---|---|
| Account → **Account Analytics** → Read | Workers, KV, D1, R2, Durable Objects, Images, etc. |
| Zone → **Analytics** → Read (all zones) | CDN, Bot Management, DNS |
| Zone → **Zone** → Read (all zones) | Listing zones |
| Zone → **Zone Settings** → Read *(optional)* | Spectrum IPv4 / app counts |

This token is only read by the Worker. It is **not** the token used to deploy.

## Configuration

| Setting | Where | Notes |
|---|---|---|
| `CF_API_TOKEN` | secret | Analytics token above |
| `DASHBOARD_PASSWORD` | secret | Basic-auth password (any username). The dashboard refuses to serve anything until it is set. |
| `ACCOUNT_ID` | `vars` in `wrangler.jsonc` | Optional. Empty = the account the token belongs to. Set it if the token can see several accounts. |
| `CAPS` | KV namespace | Caps and alert settings. Created automatically on first deploy. |
| Cron `5 * * * *` | `triggers` | Hourly cap check. |

For stronger protection than a password, put the Worker's URL behind
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/).

### Keeping your own IDs out of git

Wrangler may write the created KV namespace ID into `wrangler.jsonc`. That's fine for a private
fork. If you contribute back, keep your account-specific settings in a git-ignored
`wrangler.local.jsonc` (a copy of `wrangler.jsonc` with your `account_id` and KV `id`) and deploy
with:

```bash
npx wrangler deploy -c wrangler.local.jsonc
```

## Local development

```bash
cp .dev.vars.example .dev.vars    # then fill in CF_API_TOKEN and DASHBOARD_PASSWORD
npm run dev                       # http://127.0.0.1:8787
npm run check                     # regenerate types and type-check
```

## HTTP API

All endpoints need the dashboard password (HTTP Basic auth).

| Endpoint | Returns |
|---|---|
| `GET /api/usage?from=YYYY-MM-DD&to=YYYY-MM-DD&zones=enterprise\|all` | Account usage: `{ range, zones, sections[] }` |
| `GET /api/zone?id=<zoneId>&from=…&to=…` | One zone: `{ zone, daily[], totals, breakdowns[], errors }` |
| `GET /api/zerotrust?from=…&to=…` | Zero Trust usage: `{ range, sections[] }` |
| `GET` / `PUT /api/config` | Caps, thresholds, webhook |
| `POST /api/alerts/test` | Sends a test alert |
| `POST /api/alerts/run` | Runs the cap check now |

Add `&fresh=1` to skip the Worker's cache (1 hour, or 5 minutes when the range includes today).

Every GraphQL query the dashboard uses is documented in [docs/graphql-queries.md](docs/graphql-queries.md).

## Good to know

- **Sampled vs exact.** CDN requests, data transfer and good requests are exact. Workers, Durable
  Objects, KV, R2 operations, Queues and DNS come from sampled datasets: close, but not invoice figures.
- **Retention.** Most datasets go back far enough for a full previous month. Workflows and some
  Free-plan zone datasets keep ~31 days; the dashboard shows what is available and says which days
  are missing.
- **Spectrum concurrency.** Cloudflare only exposes the current concurrent connections, not a
  historical peak.
- **Image transformations** are counted per calendar month from the 1st.
- **Caps** are per calendar month (UTC).
- **Zero Trust history.** The daily rollups (Access, Gateway, Shadow IT, MCP) keep a year. WARP,
  Tunnel, Browser Isolation and the sampled datasets keep about a month. Ranges are split
  automatically to fit each dataset's limits (for example Access login requests: 1 week per query).

## Troubleshooting

| Problem | Fix |
|---|---|
| `wrangler deploy`: "No access to the specified service/resource" | A `CLOUDFLARE_API_TOKEN` environment variable is overriding your login. Unset it for the shell (`Remove-Item Env:CLOUDFLARE_API_TOKEN` in PowerShell, `unset CLOUDFLARE_API_TOKEN` in bash) or let `npm run setup` ignore it. |
| Webhook returns HTTP 404 for a Worker on your own `workers.dev` | Already handled by the `global_fetch_strictly_public` compatibility flag; check the URL path / ntfy topic (topics are case-sensitive). |
| Spectrum shows "Not available" | Add Zone → Zone Settings → Read to the analytics token. |
| "The API token can see N accounts" | Set `ACCOUNT_ID` in `wrangler.jsonc`. |
| `SQLITE_CANTOPEN` in `wrangler dev` on Windows | The project path is too long; run `npx wrangler dev --persist-to %TEMP%\cfud`. |

## Project layout

```
src/index.ts       routing, password check, caching, cron handler
src/usage.ts       one section per product (account overview)
src/zone.ts        zone drill-down
src/zerotrust.ts   Zero Trust (Cloudflare One) page
src/caps.ts        caps, thresholds, alert delivery (webhook / ntfy)
src/cloudflare.ts  GraphQL + REST clients, range splitting, retention fallback
public/index.html  the dashboard UI (no build step, no dependencies)
scripts/setup.mjs  one-command setup
```

## License

[MIT](LICENSE)
