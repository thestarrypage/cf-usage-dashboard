/**
 * Cloudflare usage dashboard.
 *
 *   GET /                -> dashboard UI (public/index.html)
 *   GET /api/usage?from=YYYY-MM-DD&to=YYYY-MM-DD&zones=enterprise|all
 *                        -> usage for the account, dates inclusive, UTC
 *   GET /api/zone?id=<zoneId>&from=YYYY-MM-DD&to=YYYY-MM-DD
 *                        -> CDN, Bot Management and DNS detail for one zone
 *   GET /api/zerotrust?from=YYYY-MM-DD&to=YYYY-MM-DD
 *                        -> Zero Trust (Cloudflare One) usage for the account
 *   GET|PUT /api/config  -> monthly caps, alert thresholds and webhook (KV)
 *   POST /api/alerts/test -> send a test message to the webhook
 *   POST /api/alerts/run  -> run the cap check now (also runs hourly via cron)
 *
 * The analytics come from the GraphQL Analytics API (plus a few Spectrum REST
 * endpoints that have no GraphQL equivalent), so the Worker needs an API token.
 */

import { attachCapKeys, ConfigError, DEFAULT_CONFIG, loadAlertState, loadConfig, runAlerts, saveConfig, sendTestAlert } from "./caps";
import { ApiError, detectAccountId, listZones, type Api, type Zone } from "./cloudflare";
import { buildSections, type Section } from "./usage";
import { buildZeroTrust } from "./zerotrust";
import { zoneDetail } from "./zone";

/** CAPS is optional until the KV namespace is created (see README). */
type AppEnv = Env & { CAPS?: KVNamespace };
type Handler = (request: Request, url: URL, env: AppEnv, ctx: ExecutionContext) => Promise<Response>;

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 366;

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const unauthorized = await checkAuth(request, env);
		if (unauthorized) return unauthorized;

		const url = new URL(request.url);
		const routes: Record<string, Handler> = {
			"/api/usage": handleUsage,
			"/api/zone": handleZone,
			"/api/zerotrust": handleZeroTrust,
			"/api/config": handleConfig,
			"/api/alerts/test": handleTestAlert,
			"/api/alerts/run": handleRunAlerts,
		};
		const handler = routes[url.pathname];
		if (handler) {
			try {
				return await handler(request, url, env, ctx);
			} catch (err) {
				if (err instanceof ConfigError || (err instanceof ApiError && err.setup)) return json({ error: err.message }, 400);
				console.error(JSON.stringify({ message: "request failed", path: url.pathname, error: String(err) }));
				return json({ error: err instanceof Error ? err.message : String(err) }, 500);
			}
		}
		return env.ASSETS.fetch(request);
	},

	// Hourly cap check (cron in wrangler.jsonc).
	async scheduled(_controller, env: AppEnv, ctx): Promise<void> {
		const kv = env.CAPS;
		if (!kv) return;
		ctx.waitUntil(
			apiFor(env)
				.then((api) => (api ? runAlerts(api, kv) : { checked: 0, sent: [] }))
				.then(
					(r) => console.log(JSON.stringify({ message: "cap check", checked: r.checked, sent: r.sent.length })),
					(err) => console.error(JSON.stringify({ message: "cap check failed", error: String(err) })),
				),
		);
	},
} satisfies ExportedHandler<AppEnv>;

// ---------------------------------------------------------------------------
// Caps & alerts

const KV_MISSING =
	"Caps need a KV namespace. Run: npx wrangler kv namespace create cf-usage-config --binding CAPS --update-config, then deploy again.";

async function handleConfig(request: Request, _url: URL, env: AppEnv): Promise<Response> {
	if (!env.CAPS) {
		if (request.method === "GET") return json({ ...DEFAULT_CONFIG, kvReady: false, kvMessage: KV_MISSING, alertState: null });
		return json({ error: KV_MISSING }, 503);
	}
	if (request.method === "PUT") {
		const body = await request.json().catch(() => null);
		const config = await saveConfig(env.CAPS, body);
		return json({ ...config, kvReady: true, alertState: await loadAlertState(env.CAPS) });
	}
	if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
	return json({ ...(await loadConfig(env.CAPS)), kvReady: true, alertState: await loadAlertState(env.CAPS) });
}

async function handleTestAlert(request: Request, _url: URL, env: AppEnv): Promise<Response> {
	if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
	if (!env.CAPS) return json({ error: KV_MISSING }, 503);
	const config = await loadConfig(env.CAPS);
	if (!config.webhookUrl) return json({ error: "Save a webhook URL first." }, 400);
	const api = await apiFor(env);
	await sendTestAlert(config.webhookUrl, api?.accountId ?? "");
	return json({ ok: true });
}

async function handleRunAlerts(request: Request, _url: URL, env: AppEnv): Promise<Response> {
	if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
	if (!env.CAPS) return json({ error: KV_MISSING }, 503);
	const api = await apiFor(env);
	if (!api) return json({ error: "CF_API_TOKEN secret is not set" }, 500);
	const result = await runAlerts(api, env.CAPS);
	return json({ ...result, alertState: await loadAlertState(env.CAPS) });
}

export interface UsageResponse {
	accountId: string;
	range: { from: string; to: string; days: number; timezone: "UTC" };
	zoneFilter: "enterprise" | "all";
	zones: Zone[];
	generatedAt: string;
	sections: Section[];
}

async function handleUsage(_request: Request, url: URL, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
	const from = url.searchParams.get("from") ?? "";
	const to = url.searchParams.get("to") ?? "";
	const zoneFilter = url.searchParams.get("zones") === "all" ? "all" : "enterprise";

	const problem = validateRange(from, to);
	if (problem) return json({ error: problem }, 400);
	const api = await apiFor(env);
	if (!api) return json({ error: "CF_API_TOKEN secret is not set" }, 500);

	return cached(`usage?from=${from}&to=${to}&zones=${zoneFilter}`, url, to, ctx, async () => {
		const allZones = await listZones(api);
		const zones = zoneFilter === "all" ? allZones : allZones.filter((z) => z.enterprise);
		const body: UsageResponse = {
			accountId: api.accountId,
			range: { from, to, days: daysBetween(from, to), timezone: "UTC" },
			zoneFilter,
			zones,
			generatedAt: new Date().toISOString(),
			sections: await buildSections(api, zones, { from, to }),
		};
		attachCapKeys(body.sections);
		return body;
	});
}

async function handleZeroTrust(_request: Request, url: URL, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
	const from = url.searchParams.get("from") ?? "";
	const to = url.searchParams.get("to") ?? "";
	const problem = validateRange(from, to);
	if (problem) return json({ error: problem }, 400);
	const api = await apiFor(env);
	if (!api) return json({ error: "CF_API_TOKEN secret is not set" }, 500);

	return cached(`zerotrust?from=${from}&to=${to}`, url, to, ctx, async () => ({
		accountId: api.accountId,
		range: { from, to, days: daysBetween(from, to), timezone: "UTC" },
		zones: [],
		generatedAt: new Date().toISOString(),
		sections: await buildZeroTrust(api, { from, to }),
	}));
}

async function handleZone(_request: Request, url: URL, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
	const from = url.searchParams.get("from") ?? "";
	const to = url.searchParams.get("to") ?? "";
	const id = url.searchParams.get("id") ?? "";

	const problem = validateRange(from, to);
	if (problem) return json({ error: problem }, 400);
	if (!/^[0-9a-f]{32}$/.test(id)) return json({ error: "id must be a zone ID" }, 400);
	const api = await apiFor(env);
	if (!api) return json({ error: "CF_API_TOKEN secret is not set" }, 500);

	return cached(`zone?id=${id}&from=${from}&to=${to}`, url, to, ctx, async () => {
		// Only zones in this account; also gives the zone list for the switcher.
		const zones = await listZones(api);
		const zone = zones.find((z) => z.id === id);
		if (!zone) throw new HttpError(404, "Zone not found in this account");
		return {
			accountId: api.accountId,
			range: { from, to, days: daysBetween(from, to), timezone: "UTC" },
			zones,
			generatedAt: new Date().toISOString(),
			...(await zoneDetail(api, zone, { from, to })),
		};
	});
}

class HttpError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}

/** API credentials; the account comes from ACCOUNT_ID, or from the token if that is empty. */
async function apiFor(env: Env): Promise<Api | null> {
	const token = env.CF_API_TOKEN || (env as Env & { CLOUDFLARE_API_TOKEN?: string }).CLOUDFLARE_API_TOKEN;
	if (!token) return null;
	const accountId = env.ACCOUNT_ID?.trim() || (await detectAccountId(token));
	return { token, accountId };
}

/**
 * Serve from the Cache API when possible, so reloading the page doesn't burn
 * through the GraphQL rate limit. `?fresh=1` skips the cache.
 */
async function cached(key: string, url: URL, to: string, ctx: ExecutionContext, build: () => Promise<unknown>): Promise<Response> {
	const cacheKey = new Request(`https://usage-cache.internal/v4/${key}`);
	const cache = caches.default;
	if (url.searchParams.get("fresh") !== "1") {
		const hit = await cache.match(cacheKey);
		if (hit) {
			const res = new Response(hit.body, hit);
			res.headers.set("X-Cache", "HIT");
			res.headers.set("Cache-Control", BROWSER_CACHE);
			return res;
		}
	}
	let body: unknown;
	try {
		body = await build();
	} catch (err) {
		if (err instanceof HttpError) return json({ error: err.message }, err.status);
		throw err;
	}
	// Ranges that include today are still filling in; cache those briefly.
	const includesToday = to >= todayUtc();
	const res = json(body, 200, { "Cache-Control": `max-age=${includesToday ? 300 : 3600}` });
	ctx.waitUntil(cache.put(cacheKey, res.clone()));
	res.headers.set("X-Cache", "MISS");
	res.headers.set("Cache-Control", BROWSER_CACHE);
	return res;
}

// The Worker caches responses itself; browsers must not, or a redeploy keeps showing old data.
const BROWSER_CACHE = "private, no-store";

function validateRange(from: string, to: string): string | null {
	const re = /^\d{4}-\d{2}-\d{2}$/;
	if (!re.test(from) || !re.test(to)) return "from and to must be dates in YYYY-MM-DD format";
	if (Number.isNaN(Date.parse(`${from}T00:00:00Z`)) || Number.isNaN(Date.parse(`${to}T00:00:00Z`))) return "invalid date";
	if (from > to) return "from must be on or before to";
	if (to > todayUtc()) return "to cannot be in the future";
	if (daysBetween(from, to) > MAX_RANGE_DAYS) return `range cannot exceed ${MAX_RANGE_DAYS} days`;
	return null;
}

function daysBetween(from: string, to: string): number {
	return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

function todayUtc(): string {
	return new Date().toISOString().slice(0, 10);
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
	});
}

/** HTTP Basic auth against DASHBOARD_PASSWORD (any username). Returns a 401 response, or null when allowed. */
async function checkAuth(request: Request, env: Env): Promise<Response | null> {
	const expected = env.DASHBOARD_PASSWORD;
	if (!expected) {
		return new Response("DASHBOARD_PASSWORD secret is not set; refusing to serve account usage without a password.", {
			status: 503,
		});
	}
	const header = request.headers.get("Authorization") ?? "";
	let supplied = "";
	if (header.startsWith("Basic ")) {
		try {
			const decoded = atob(header.slice(6));
			supplied = decoded.slice(decoded.indexOf(":") + 1);
		} catch {
			supplied = "";
		}
	}
	if (supplied && (await timingSafeEqualStrings(supplied, expected))) return null;
	return new Response("Authentication required", {
		status: 401,
		headers: { "WWW-Authenticate": 'Basic realm="Cloudflare usage", charset="UTF-8"' },
	});
}

async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
	// Hash both sides first so the comparison is constant-length.
	const enc = new TextEncoder();
	const [ha, hb] = await Promise.all([
		crypto.subtle.digest("SHA-256", enc.encode(a)),
		crypto.subtle.digest("SHA-256", enc.encode(b)),
	]);
	return crypto.subtle.timingSafeEqual(ha, hb);
}
