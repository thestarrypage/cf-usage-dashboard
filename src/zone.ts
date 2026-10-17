/** Drill-down for one zone: CDN, Bot Management and DNS detail over a date range. */

import { zoneRows, type Api, type DateRange, type Row, type Zone } from "./cloudflare";
import type { Table, Unit } from "./usage";

export interface DailyPoint {
	date: string;
	requests: number;
	bytes: number;
	cachedRequests: number;
	cachedBytes: number;
	threats: number;
	good: number;
	pageViews: number;
	uniques: number;
	dnsQueries: number;
}

export interface Breakdown extends Table {
	id: string;
	group: "CDN" | "Bot Management" | "DNS";
	sampled: boolean;
	note?: string;
}

export interface ZoneDetail {
	zone: Zone;
	daily: DailyPoint[];
	totals: Omit<DailyPoint, "date" | "uniques">;
	breakdowns: Breakdown[];
	errors: string[];
}

const TOP_N = 15;

export async function zoneDetail(api: Api, zone: Zone, range: DateRange): Promise<ZoneDetail> {
	const errors: string[] = [];

	// Exact daily rollups, including per-country / status / content-type maps.
	const daily = zoneRows(
		api,
		zone.id,
		"httpRequests1dGroups",
		`{ dimensions { date } uniq { uniques } sum {
			requests bytes cachedRequests cachedBytes threats pageViews
			countryMap { clientCountryName requests bytes threats }
			responseStatusMap { edgeResponseStatus requests }
			contentTypeMap { edgeResponseContentTypeName requests bytes }
		} }`,
		range,
	);

	// Sampled breakdowns from the adaptive dataset (visitor traffic only).
	const adaptive = (id: string, dims: string, extraSum = "") =>
		zoneRows(
			api,
			zone.id,
			"httpRequestsAdaptiveGroups",
			`{ count ${extraSum ? `sum { ${extraSum} }` : ""} dimensions { ${dims} } }`,
			range,
			// Top groups first, so long-tail dimensions (paths, hosts) don't crowd out the big ones.
			{ extraFilter: 'requestSource: "eyeball"', orderBy: "count_DESC", limit: 500 },
		).then((r) => ({ id, ...r }));

	// Authoritative DNS answered by Cloudflare for this zone (sampled, rounded to 100).
	const dns = (id: string, dims: string) =>
		zoneRows(api, zone.id, "dnsAnalyticsAdaptiveGroups", `{ count dimensions { ${dims} } }`, range, {
			orderBy: "count_DESC",
			limit: 500,
		}).then((r) => ({ id, ...r }));
	const dnsDaily = zoneRows(api, zone.id, "dnsAnalyticsAdaptiveGroups", "{ count dimensions { date } }", range);

	const [d, dd, ...sampled] = await Promise.all([
		daily,
		dnsDaily,
		adaptive("decision", "botManagementDecision"),
		adaptive("score", "botScoreBucketBy10"),
		adaptive("source", "botScoreSrcName"),
		adaptive("verified", "verifiedBotCategory"),
		adaptive("security", "securityAction securitySource"),
		adaptive("cache", "cacheStatus", "edgeResponseBytes"),
		adaptive("hosts", "clientRequestHTTPHost", "edgeResponseBytes"),
		adaptive("paths", "clientRequestPath", "edgeResponseBytes"),
		adaptive("devices", "clientDeviceType"),
		dns("dnsType", "queryType"),
		dns("dnsCode", "responseCode"),
		dns("dnsName", "queryName"),
		dns("dnsProto", "protocol ipVersion"),
		dns("dnsCached", "responseCached"),
		dns("dnsColo", "coloName"),
	]);
	errors.push(...dd.errors.map((e) => `DNS queries per day: ${e}`));
	errors.push(...d.errors.map((e) => `Daily totals: ${e}`));
	const byId = new Map(sampled.map((s) => [s.id, s]));
	const titles: Record<string, string> = {
		decision: "Bot Management decision", score: "Bot score distribution", source: "Detection engine",
		verified: "Verified bot categories", security: "Security actions", cache: "Cache status",
		hosts: "Top hostnames", paths: "Top paths", devices: "Device types",
		dnsType: "DNS query types", dnsCode: "DNS response codes", dnsName: "Top DNS query names",
		dnsProto: "DNS protocol", dnsCached: "DNS response cached", dnsColo: "DNS by data center",
	};
	for (const s of sampled) {
		for (const e of s.errors) {
			errors.push(
				/does not have access to the field/i.test(e)
					? `${titles[s.id]}: not available for this zone (needs Bot Management on the zone's plan).`
					: `${titles[s.id]}: ${e}`,
			);
		}
	}

	// ---- daily series --------------------------------------------------------
	const points = new Map<string, DailyPoint>();
	for (const r of d.rows) {
		const date = String(get(r, "dimensions.date"));
		const p = points.get(date) ?? emptyPoint(date);
		p.requests += num(get(r, "sum.requests"));
		p.bytes += num(get(r, "sum.bytes"));
		p.cachedRequests += num(get(r, "sum.cachedRequests"));
		p.cachedBytes += num(get(r, "sum.cachedBytes"));
		p.threats += num(get(r, "sum.threats"));
		p.pageViews += num(get(r, "sum.pageViews"));
		p.uniques += num(get(r, "uniq.uniques"));
		p.good = p.requests - p.threats;
		points.set(date, p);
	}
	for (const r of dd.rows) {
		const date = String(get(r, "dimensions.date"));
		const p = points.get(date) ?? emptyPoint(date);
		p.dnsQueries += num(r.count);
		points.set(date, p);
	}
	const series = fillDays(range, points);
	const totals = series.reduce(
		(t, p) => ({
			requests: t.requests + p.requests,
			bytes: t.bytes + p.bytes,
			cachedRequests: t.cachedRequests + p.cachedRequests,
			cachedBytes: t.cachedBytes + p.cachedBytes,
			threats: t.threats + p.threats,
			good: t.good + p.good,
			pageViews: t.pageViews + p.pageViews,
			dnsQueries: t.dnsQueries + p.dnsQueries,
		}),
		{ requests: 0, bytes: 0, cachedRequests: 0, cachedBytes: 0, threats: 0, good: 0, pageViews: 0, dnsQueries: 0 },
	);

	// ---- exact breakdowns from the daily maps --------------------------------
	const mapAgg = (field: string, key: string, metrics: string[]) => {
		const out = new Map<string, Record<string, number>>();
		for (const r of d.rows) {
			const list = get(r, `sum.${field}`);
			if (!Array.isArray(list)) continue;
			for (const item of list as Row[]) {
				const k = String(item[key] ?? "unknown");
				const acc = out.get(k) ?? Object.fromEntries(metrics.map((m) => [m, 0]));
				for (const m of metrics) acc[m] += num(item[m]);
				out.set(k, acc);
			}
		}
		return [...out.entries()].sort((a, b) => b[1][metrics[0]] - a[1][metrics[0]]);
	};

	const countries = mapAgg("countryMap", "clientCountryName", ["requests", "bytes", "threats"]);
	const statuses = mapAgg("responseStatusMap", "edgeResponseStatus", ["requests"]);
	const contentTypes = mapAgg("contentTypeMap", "edgeResponseContentTypeName", ["requests", "bytes"]);

	// Device types cover every request, so their sampled total is the denominator for long-tail tables.
	const sampledTotal = (byId.get("devices")?.rows ?? []).reduce((acc, r) => acc + num(r.count), 0);

	const breakdowns: Breakdown[] = [
		{
			id: "countries",
			group: "CDN",
			sampled: false,
			title: "Top countries",
			columns: [
				{ key: "country", label: "Country" },
				{ key: "requests", label: "Requests", unit: "count" },
				{ key: "share", label: "Share", unit: "percent" },
				{ key: "bytes", label: "Data transfer", unit: "bytes" },
				{ key: "good", label: "Good requests", unit: "count" },
				{ key: "threats", label: "Threats", unit: "count" },
			],
			rows: countries.slice(0, TOP_N).map(([country, v]) => ({
				country: countryName(country),
				requests: v.requests,
				share: share(v.requests, totals.requests),
				bytes: v.bytes,
				good: v.requests - v.threats,
				threats: v.threats,
			})),
		},
		{
			id: "status",
			group: "CDN",
			sampled: false,
			title: "Response status codes",
			columns: [
				{ key: "status", label: "Status" },
				{ key: "requests", label: "Requests", unit: "count" },
				{ key: "share", label: "Share", unit: "percent" },
			],
			rows: statuses.slice(0, TOP_N).map(([status, v]) => ({ status, requests: v.requests, share: share(v.requests, totals.requests) })),
		},
		{
			id: "content",
			group: "CDN",
			sampled: false,
			title: "Content types",
			columns: [
				{ key: "type", label: "Content type" },
				{ key: "requests", label: "Requests", unit: "count" },
				{ key: "bytes", label: "Data transfer", unit: "bytes" },
				{ key: "share", label: "Share of bytes", unit: "percent" },
			],
			rows: contentTypes.slice(0, TOP_N).map(([type, v]) => ({ type, requests: v.requests, bytes: v.bytes, share: share(v.bytes, totals.bytes) })),
		},
		sampledTable(byId.get("cache"), "cache", "CDN", "Cache status", "cacheStatus", "Cache status", true),
		sampledTable(byId.get("hosts"), "hosts", "CDN", "Top hostnames", "clientRequestHTTPHost", "Hostname", true, undefined, undefined, sampledTotal),
		sampledTable(byId.get("paths"), "paths", "CDN", "Top paths", "clientRequestPath", "Path", true, undefined, undefined, sampledTotal),
		sampledTable(byId.get("devices"), "devices", "CDN", "Device types", "clientDeviceType", "Device"),
		sampledTable(byId.get("decision"), "decision", "Bot Management", "Bot Management decision", "botManagementDecision", "Decision", false,
			"How Bot Management classified each visitor request."),
		sampledTable(byId.get("score"), "score", "Bot Management", "Bot score distribution", "botScoreBucketBy10", "Bot score", false,
			"1 = almost certainly automated, 99 = almost certainly human.", (k) => scoreBucket(k)),
		sampledTable(byId.get("source"), "source", "Bot Management", "Detection engine", "botScoreSrcName", "Engine"),
		sampledTable(byId.get("verified"), "verified", "Bot Management", "Verified bot categories", "verifiedBotCategory", "Category", false,
			"Known good bots (search engines, monitoring, etc.).", (k) => (k ? k : "(not a verified bot)")),
		{
			...sampledTable(byId.get("security"), "security", "Bot Management", "Security actions", "securityAction", "Action", false,
				"Which security feature acted on requests. Block, managed challenge and AI Labyrinth visits are not good requests."),
			columns: [
				{ key: "key", label: "Action" },
				{ key: "source", label: "Security feature" },
				{ key: "requests", label: "Requests (sampled)", unit: "count" },
				{ key: "share", label: "Share", unit: "percent" },
			],
			rows: securityRows(byId.get("security")?.rows ?? []),
		},
		...[
			sampledTable(byId.get("dnsType"), "dnsType", "DNS", "Query types", "queryType", "Record type"),
			sampledTable(byId.get("dnsCode"), "dnsCode", "DNS", "Response codes", "responseCode", "Response code", false,
				"NXDOMAIN = the name asked for doesn't exist (often scanners or typos)."),
			sampledTable(byId.get("dnsName"), "dnsName", "DNS", "Top query names", "queryName", "Name"),
			{
				...sampledTable(byId.get("dnsProto"), "dnsProto", "DNS", "Protocol & IP version", "protocol", "Protocol"),
				rows: protoRows(byId.get("dnsProto")?.rows ?? []),
			},
			sampledTable(byId.get("dnsCached"), "dnsCached", "DNS", "Answered from cache", "responseCached", "Cached", false, undefined,
				(k) => (k === "1" || k === "true" ? "Yes" : k === "0" || k === "false" ? "No" : k || "(unknown)")),
			sampledTable(byId.get("dnsColo"), "dnsColo", "DNS", "Top data centers", "coloName", "Data center"),
		].map((b) => ({ ...b, columns: b.columns.map((c) => (c.key === "requests" ? { ...c, label: "Queries (sampled)" } : c)) })),
	];

	return { zone, daily: series, totals, breakdowns, errors };
}

// ---------------------------------------------------------------------------

function sampledTable(
	result: { rows: Row[] } | undefined,
	id: string,
	group: Breakdown["group"],
	title: string,
	dim: string,
	label: string,
	withBytes = false,
	note?: string,
	keyFormat: (k: string) => string = (k) => (k === "" ? "(none)" : k),
	denominator?: number,
): Breakdown {
	const agg = new Map<string, { requests: number; bytes: number }>();
	for (const r of result?.rows ?? []) {
		const k = String(get(r, `dimensions.${dim}`) ?? "");
		const a = agg.get(k) ?? { requests: 0, bytes: 0 };
		a.requests += num(r.count);
		a.bytes += num(get(r, "sum.edgeResponseBytes"));
		agg.set(k, a);
	}
	const total = denominator || [...agg.values()].reduce((s, v) => s + v.requests, 0);
	const sorted = [...agg.entries()].sort((a, b) => (id === "score" ? Number(a[0]) - Number(b[0]) : b[1].requests - a[1].requests));
	const columns: { key: string; label: string; unit?: Unit }[] = [
		{ key: "key", label },
		{ key: "requests", label: "Requests (sampled)", unit: "count" },
		{ key: "share", label: "Share", unit: "percent" },
	];
	if (withBytes) columns.push({ key: "bytes", label: "Data transfer (sampled)", unit: "bytes" });
	return {
		id,
		group,
		sampled: true,
		title,
		note,
		columns,
		rows: (id === "score" ? sorted : sorted.slice(0, TOP_N)).map(([k, v]) => ({
			key: keyFormat(k),
			requests: v.requests,
			share: share(v.requests, total),
			...(withBytes ? { bytes: v.bytes } : {}),
		})),
	};
}

function securityRows(rows: Row[]): Record<string, string | number | null>[] {
	const agg = new Map<string, { action: string; source: string; requests: number }>();
	for (const r of rows) {
		const action = String(get(r, "dimensions.securityAction") ?? "unknown");
		const source = String(get(r, "dimensions.securitySource") ?? "unknown");
		const k = `${action}|${source}`;
		const a = agg.get(k) ?? { action, source, requests: 0 };
		a.requests += num(r.count);
		agg.set(k, a);
	}
	const total = [...agg.values()].reduce((s, v) => s + v.requests, 0);
	return [...agg.values()]
		.sort((a, b) => b.requests - a.requests)
		.slice(0, TOP_N)
		.map((v) => ({
			key: v.action === "unknown" ? "none (not acted on)" : v.action,
			source: v.source === "unknown" ? "—" : v.source,
			requests: v.requests,
			share: share(v.requests, total),
		}));
}

function protoRows(rows: Row[]): Record<string, string | number | null>[] {
	const agg = new Map<string, number>();
	for (const r of rows) {
		const k = `${get(r, "dimensions.protocol") ?? "?"} · IPv${get(r, "dimensions.ipVersion") ?? "?"}`;
		agg.set(k, (agg.get(k) ?? 0) + num(r.count));
	}
	const total = [...agg.values()].reduce((a, b) => a + b, 0);
	return [...agg.entries()].sort((a, b) => b[1] - a[1]).map(([key, requests]) => ({ key, requests, share: share(requests, total) }));
}

function scoreBucket(k: string): string {
	const n = Number(k);
	if (!Number.isFinite(n)) return k || "(not scored)";
	const lo = Math.max(1, n);
	return `${lo}–${n + 9}`;
}

function emptyPoint(date: string): DailyPoint {
	return { date, requests: 0, bytes: 0, cachedRequests: 0, cachedBytes: 0, threats: 0, good: 0, pageViews: 0, uniques: 0, dnsQueries: 0 };
}

function fillDays(range: DateRange, points: Map<string, DailyPoint>): DailyPoint[] {
	const out: DailyPoint[] = [];
	for (let t = Date.parse(`${range.from}T00:00:00Z`); t <= Date.parse(`${range.to}T00:00:00Z`); t += 86_400_000) {
		const date = new Date(t).toISOString().slice(0, 10);
		out.push(points.get(date) ?? emptyPoint(date));
	}
	return out;
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
function countryName(code: string): string {
	if (!/^[A-Z]{2}$/.test(code)) return code || "Unknown";
	try {
		return `${regionNames.of(code) ?? code} (${code})`;
	} catch {
		return code;
	}
}

function share(part: number, whole: number): number | null {
	return whole > 0 ? (part / whole) * 100 : null;
}

function get(row: Row, path: string): unknown {
	let cur: unknown = row;
	for (const part of path.split(".")) {
		if (cur === null || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[part];
	}
	return cur;
}

function num(v: unknown): number {
	const n = typeof v === "number" ? v : Number(v);
	return Number.isFinite(n) ? n : 0;
}
