/**
 * Subscription caps and alerting.
 *
 * Caps are monthly limits per billable metric. Usage for the current calendar
 * month (UTC) is compared against them; crossing the warning / critical
 * thresholds, or the cap itself, sends one webhook message per level per month.
 * Settings live in the CAPS KV namespace.
 */

import { listZones, type Api } from "./cloudflare";
import { buildSections, type Section, type Unit } from "./usage";

/** Metrics that can carry a cap: `${sectionId}|${metric label}` → stable cap key. */
const CAPPABLE: Record<string, string> = {
	"cdn|CDN requests": "cdn.requests",
	"cdn|CDN data transfer": "cdn.bytes",
	"good-requests|Good requests": "bot.goodRequests",
	"dns|DNS queries": "dns.queries",
	"spectrum|IPv4 addresses": "spectrum.ipv4",
	"spectrum|Data transfer (in + out)": "spectrum.bytes",
	"spectrum|Concurrent connections now": "spectrum.concurrent",
	"images|Unique transformations (billable)": "images.uniqueTransformations",
	"workers|Requests": "workers.requests",
	"workers|CPU time": "workers.cpuMs",
	"kv|Reads": "kv.reads",
	"kv|Writes": "kv.writes",
	"kv|Deletes": "kv.deletes",
	"kv|Lists": "kv.lists",
	"kv|Storage (end of range)": "kv.storage",
	"d1|Rows read": "d1.rowsRead",
	"d1|Rows written": "d1.rowsWritten",
	"d1|Storage (end of range)": "d1.storage",
	"durable-objects|Requests": "do.requests",
	"durable-objects|Duration": "do.duration",
	"durable-objects|SQL rows read": "do.rowsRead",
	"durable-objects|SQL rows written": "do.rowsWritten",
	"durable-objects|SQL storage (end of range)": "do.sqlStorage",
	"containers|vCPU time": "containers.cpu",
	"containers|Memory": "containers.memory",
	"containers|Disk": "containers.disk",
	"containers|Egress": "containers.egress",
	"queues|Billable operations": "queues.operations",
	"workflows|Instances started": "workflows.instances",
	"workflows|CPU time": "workflows.cpuMs",
	"pages|Requests": "pages.requests",
	"r2|Class A operations": "r2.classA",
	"r2|Class B operations": "r2.classB",
	"r2|Standard storage (end of range)": "r2.storageStandard",
	"r2|Infrequent Access storage (end)": "r2.storageIA",
};

export function attachCapKeys(sections: Section[]): void {
	for (const s of sections) for (const m of s.metrics) {
		const key = CAPPABLE[`${s.id}|${m.label}`];
		if (key) m.capKey = key;
	}
}

// ---------------------------------------------------------------------------
// Config

export interface CapsConfig {
	caps: Record<string, number>;
	warning: number; // percent of cap
	critical: number; // percent of cap
	webhookUrl: string;
	zoneFilter: "enterprise" | "all";
	updatedAt?: string;
}

export const DEFAULT_CONFIG: CapsConfig = { caps: {}, warning: 80, critical: 90, webhookUrl: "", zoneFilter: "enterprise" };
const CONFIG_KEY = "config";
const KNOWN_KEYS = new Set(Object.values(CAPPABLE));

export async function loadConfig(kv: KVNamespace): Promise<CapsConfig> {
	const stored = await kv.get<Partial<CapsConfig>>(CONFIG_KEY, "json");
	return { ...DEFAULT_CONFIG, ...(stored ?? {}), caps: { ...(stored?.caps ?? {}) } };
}

export async function saveConfig(kv: KVNamespace, input: unknown): Promise<CapsConfig> {
	const config = validateConfig(input);
	config.updatedAt = new Date().toISOString();
	await kv.put(CONFIG_KEY, JSON.stringify(config));
	return config;
}

export class ConfigError extends Error {}

function validateConfig(input: unknown): CapsConfig {
	if (!input || typeof input !== "object") throw new ConfigError("Body must be a JSON object");
	const i = input as Record<string, unknown>;
	const warning = Number(i.warning);
	const critical = Number(i.critical);
	if (!Number.isInteger(warning) || warning < 1 || warning > 100) throw new ConfigError("warning must be a whole number from 1 to 100");
	if (!Number.isInteger(critical) || critical < 1 || critical > 100) throw new ConfigError("critical must be a whole number from 1 to 100");
	if (warning >= critical) throw new ConfigError("warning must be lower than critical");

	const webhookUrl = typeof i.webhookUrl === "string" ? i.webhookUrl.trim() : "";
	if (webhookUrl) {
		let u: URL;
		try {
			u = new URL(webhookUrl);
		} catch {
			throw new ConfigError("webhookUrl is not a valid URL");
		}
		// Plain http only for a receiver on this machine (local testing with `wrangler dev`).
		const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
		if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new ConfigError("webhookUrl must use https");
	}

	const caps: Record<string, number> = {};
	const rawCaps = (i.caps ?? {}) as Record<string, unknown>;
	if (typeof rawCaps !== "object") throw new ConfigError("caps must be an object");
	for (const [k, v] of Object.entries(rawCaps)) {
		if (!KNOWN_KEYS.has(k)) throw new ConfigError(`unknown cap: ${k}`);
		if (v === null || v === "" || v === undefined) continue;
		const n = Number(v);
		if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`cap for ${k} must be a positive number`);
		caps[k] = n;
	}
	return { caps, warning, critical, webhookUrl, zoneFilter: i.zoneFilter === "all" ? "all" : "enterprise" };
}

// ---------------------------------------------------------------------------
// Evaluation

export type Level = "ok" | "warning" | "critical" | "exceeded";
const RANK: Record<Level, number> = { ok: 0, warning: 1, critical: 2, exceeded: 3 };

export interface CapStatus {
	key: string;
	section: string;
	label: string;
	unit: Unit;
	value: number;
	cap: number;
	percent: number;
	level: Level;
}

export function evaluate(sections: Section[], config: CapsConfig): CapStatus[] {
	const out: CapStatus[] = [];
	for (const s of sections) for (const m of s.metrics) {
		if (!m.capKey || !(m.capKey in config.caps) || m.value === null) continue;
		const cap = config.caps[m.capKey];
		const percent = (m.value / cap) * 100;
		const level: Level =
			percent >= 100 ? "exceeded" : percent >= config.critical ? "critical" : percent >= config.warning ? "warning" : "ok";
		out.push({ key: m.capKey, section: s.title, label: m.label, unit: m.unit, value: m.value, cap, percent, level });
	}
	return out.sort((a, b) => b.percent - a.percent);
}

export function monthToDate(now = new Date()): { from: string; to: string; month: string } {
	const iso = now.toISOString();
	return { from: `${iso.slice(0, 7)}-01`, to: iso.slice(0, 10), month: iso.slice(0, 7) };
}

// ---------------------------------------------------------------------------
// Alerting (hourly cron, plus the "send test alert" button)

interface AlertState {
	month: string;
	levels: Record<string, Level>;
	lastRun?: string;
	lastSent?: string;
	lastError?: string;
}
const STATE_KEY = "alert-state";

export async function loadAlertState(kv: KVNamespace): Promise<AlertState | null> {
	return kv.get<AlertState>(STATE_KEY, "json");
}

export async function runAlerts(api: Api, kv: KVNamespace): Promise<{ checked: number; sent: CapStatus[] }> {
	const config = await loadConfig(kv);
	const mtd = monthToDate();
	const prev = await loadAlertState(kv);
	const state: AlertState = prev?.month === mtd.month ? prev : { month: mtd.month, levels: {} };
	state.lastRun = new Date().toISOString();

	if (Object.keys(config.caps).length === 0) {
		await kv.put(STATE_KEY, JSON.stringify(state));
		return { checked: 0, sent: [] };
	}

	const zones = (await listZones(api)).filter((z) => config.zoneFilter === "all" || z.enterprise);
	const sections = await buildSections(api, zones, mtd);
	attachCapKeys(sections);
	const statuses = evaluate(sections, config);

	// Only notify when a metric reaches a higher level than already notified this month.
	const rising = statuses.filter((s) => s.level !== "ok" && RANK[s.level] > RANK[state.levels[s.key] ?? "ok"]);
	if (rising.length && config.webhookUrl) {
		try {
			await sendWebhook(config.webhookUrl, alertMessage(rising, config, api.accountId, mtd), rising);
			for (const s of rising) state.levels[s.key] = s.level;
			state.lastSent = state.lastRun;
			state.lastError = undefined;
		} catch (err) {
			state.lastError = err instanceof Error ? err.message : String(err);
		}
	}
	await kv.put(STATE_KEY, JSON.stringify(state));
	return { checked: statuses.length, sent: config.webhookUrl ? rising : [] };
}

export async function sendTestAlert(webhookUrl: string, accountId: string): Promise<void> {
	const sample: CapStatus = {
		key: "test", section: "Test", label: "Example metric", unit: "count", value: 85, cap: 100, percent: 85, level: "warning",
	};
	await sendWebhook(
		webhookUrl,
		`✅ Test alert from the Cloudflare usage dashboard (account ${accountId}). Cap alerts will arrive here.`,
		[sample],
		true,
	);
}

function alertMessage(rising: CapStatus[], config: CapsConfig, accountId: string, mtd: { from: string; to: string }): string {
	const icon: Record<Level, string> = { ok: "", warning: "⚠️", critical: "🔶", exceeded: "🛑" };
	const word: Record<Level, string> = { ok: "", warning: "Warning", critical: "Critical", exceeded: "Over cap" };
	const lines = rising.map(
		(s) => `${icon[s.level]} ${word[s.level]}: ${s.section} – ${s.label} at ${s.percent.toFixed(1)}% of cap (${formatValue(s.value, s.unit)} / ${formatValue(s.cap, s.unit)})`,
	);
	return [
		`Cloudflare usage alert – account ${accountId}, ${mtd.from} to ${mtd.to} (UTC)`,
		...lines,
		`Thresholds: warning ${config.warning}%, critical ${config.critical}%.`,
	].join("\n");
}

async function sendWebhook(url: string, text: string, alerts: CapStatus[], test = false): Promise<void> {
	let res: Response;
	if (await isNtfy(url)) {
		// ntfy: plain-text body; title, priority and emoji tags go in headers (ASCII only).
		const top = alerts.reduce<Level>((lv, a) => (RANK[a.level] > RANK[lv] ? a.level : lv), "ok");
		const ntfy: Record<Level, { priority: string; tags: string }> = {
			ok: { priority: "3", tags: "white_check_mark" },
			warning: { priority: "3", tags: "warning" },
			critical: { priority: "4", tags: "rotating_light" },
			exceeded: { priority: "5", tags: "no_entry" },
		};
		const style = test ? ntfy.ok : ntfy[top];
		res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				Title: test ? "Cloudflare usage: test alert" : "Cloudflare usage alert",
				Priority: style.priority,
				Tags: style.tags,
			},
			body: text,
		});
	} else {
		// `text` suits Slack / Teams / Google Chat, `content` suits Discord; other receivers get `alerts`.
		res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text, content: text.slice(0, 1900), alerts }),
		});
	}
	if (!res.ok) {
		const detail = (await res.text().catch(() => "")).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
		const hint = res.status === 404 ? " (check the URL path / topic name)" : "";
		throw new Error(`Webhook returned HTTP ${res.status}${hint}${detail ? `: ${detail}` : ""}`);
	}
}

/** ntfy servers answer GET /v1/health with {"healthy": true}. */
async function isNtfy(url: string): Promise<boolean> {
	try {
		const res = await fetch(`${new URL(url).origin}/v1/health`, { signal: AbortSignal.timeout(5000) });
		if (!res.ok) return false;
		const body = (await res.json().catch(() => null)) as { healthy?: unknown } | null;
		return typeof body?.healthy === "boolean";
	} catch {
		return false;
	}
}

function formatValue(v: number, unit: Unit): string {
	const nf = new Intl.NumberFormat("en", { maximumFractionDigits: 2 });
	if (unit === "bytes") {
		const u = ["B", "KB", "MB", "GB", "TB", "PB"];
		const i = v > 0 ? Math.min(Math.floor(Math.log10(v) / 3), u.length - 1) : 0;
		return `${nf.format(v / 10 ** (3 * i))} ${u[i]}`;
	}
	const suffix: Partial<Record<Unit, string>> = { ms: " ms", seconds: " s", gbSeconds: " GB-s", gibSeconds: " GiB-s", percent: "%" };
	return `${nf.format(v)}${suffix[unit] ?? ""}`;
}
