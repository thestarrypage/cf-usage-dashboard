/** Builds one dashboard section per product from the analytics datasets. */

import { accountRows, isLastPage, rest, splitRange, zoneRows, type Api, type DateRange, type Row, type Zone } from "./cloudflare";

export type Unit = "count" | "bytes" | "percent" | "ms" | "seconds" | "gbSeconds" | "gibSeconds";

export interface Metric {
	label: string;
	value: number | null;
	unit: Unit;
	hint?: string;
	/** Set on billable metrics that can have a monthly cap (see caps.ts). */
	capKey?: string;
}

export interface Column {
	key: string;
	label: string;
	unit?: Unit;
}

export interface Table {
	title: string;
	columns: Column[];
	rows: Record<string, string | number | null>[];
}

export interface Section {
	id: string;
	group: string;
	title: string;
	source: string;
	metrics: Metric[];
	tables: Table[];
	notes: string[];
	errors: string[];
}

export async function buildSections(api: Api, zones: Zone[], range: DateRange): Promise<Section[]> {
	const builders: [string, () => Promise<Section[]>][] = [
		["cdn", () => cdnAndGoodRequests(api, zones, range)],
		["dns", async () => [await dnsQueries(api, zones, range)]],
		["spectrum", async () => [await spectrum(api, zones, range)]],
		["images", async () => [await images(api, range)]],
		["workers", async () => [await workers(api, range)]],
		["kv", async () => [await kv(api, range)]],
		["d1", async () => [await d1(api, range)]],
		["durable-objects", async () => [await durableObjects(api, range)]],
		["containers", async () => [await containers(api, range)]],
		["queues", async () => [await queues(api, range)]],
		["workflows", async () => [await workflows(api, range)]],
		["pages", async () => [await pages(api, range)]],
		["r2", async () => [await r2(api, range)]],
	];
	const settled = await Promise.allSettled(builders.map(([, fn]) => fn()));
	return settled.flatMap((s, i) =>
		s.status === "fulfilled" ? s.value : [failedSection(builders[i][0], s.reason)],
	);
}

// ---------------------------------------------------------------------------
// Zones: CDN requests, data transfer and Bot Management good requests

async function cdnAndGoodRequests(api: Api, zones: Zone[], range: DateRange): Promise<Section[]> {
	const perZone = await Promise.all(
		zones.map(async (z) => {
			const r = await zoneRows(api, z.id, "httpRequests1dGroups", "{ sum { requests bytes cachedRequests cachedBytes threats } }", range);
			const requests = total(r.rows, "sum.requests");
			const threats = total(r.rows, "sum.threats");
			return {
				zone: z,
				requests,
				bytes: total(r.rows, "sum.bytes"),
				cachedRequests: total(r.rows, "sum.cachedRequests"),
				cachedBytes: total(r.rows, "sum.cachedBytes"),
				threats,
				good: requests - threats,
				errors: r.errors.map((e) => `${z.name}: ${e}`),
			};
		}),
	);
	const sum = (k: "requests" | "bytes" | "cachedRequests" | "cachedBytes" | "threats" | "good") =>
		perZone.reduce((acc, z) => acc + z[k], 0);
	const errors = perZone.flatMap((z) => z.errors);
	const noZones = zones.length === 0 ? ["No zones match the zone filter."] : [];

	const cdn: Section = {
		id: "cdn",
		group: "Zones",
		title: "CDN requests & data transfer",
		source: "httpRequests1dGroups",
		metrics: [
			{ label: "CDN requests", value: sum("requests"), unit: "count" },
			{ label: "CDN data transfer", value: sum("bytes"), unit: "bytes", hint: "Bytes sent from Cloudflare to visitors" },
			{ label: "Requests served from cache", value: pct(sum("cachedRequests"), sum("requests")), unit: "percent" },
			{ label: "Bytes served from cache", value: pct(sum("cachedBytes"), sum("bytes")), unit: "percent" },
		],
		tables: [
			{
				title: "Per zone",
				columns: [
					{ key: "zone", label: "Zone" },
					{ key: "plan", label: "Plan" },
					{ key: "requests", label: "Requests", unit: "count" },
					{ key: "bytes", label: "Data transfer", unit: "bytes" },
					{ key: "cachedRequests", label: "Cached requests", unit: "count" },
					{ key: "cachedBytes", label: "Cached bytes", unit: "bytes" },
				],
				rows: [
					...perZone.map((z) => ({
						zone: z.zone.name,
						zoneId: z.zone.id,
						plan: z.zone.plan,
						requests: z.requests,
						bytes: z.bytes,
						cachedRequests: z.cachedRequests,
						cachedBytes: z.cachedBytes,
					})),
					{ zone: "Total", plan: "", requests: sum("requests"), bytes: sum("bytes"), cachedRequests: sum("cachedRequests"), cachedBytes: sum("cachedBytes") },
				],
			},
		],
		notes: [...noZones],
		errors,
	};

	const good: Section = {
		id: "good-requests",
		group: "Zones",
		title: "Bot Management – good requests",
		source: "httpRequests1dGroups (requests − threats)",
		metrics: [
			{ label: "Good requests", value: sum("good"), unit: "count" },
			{ label: "Threats (blocked / challenged)", value: sum("threats"), unit: "count" },
			{ label: "Good share", value: pct(sum("good"), sum("requests")), unit: "percent" },
		],
		tables: [
			{
				title: "Per zone",
				columns: [
					{ key: "zone", label: "Zone" },
					{ key: "requests", label: "Total requests", unit: "count" },
					{ key: "threats", label: "Threats", unit: "count" },
					{ key: "good", label: "Good requests", unit: "count" },
					{ key: "goodPct", label: "Good %", unit: "percent" },
				],
				rows: [
					...perZone.map((z) => ({ zone: z.zone.name, zoneId: z.zone.id, requests: z.requests, threats: z.threats, good: z.good, goodPct: pct(z.good, z.requests) })),
					{ zone: "Total", requests: sum("requests"), threats: sum("threats"), good: sum("good"), goodPct: pct(sum("good"), sum("requests")) },
				],
			},
		],
		notes: [
			"Good requests = total requests minus requests Cloudflare counted as threats (blocked or challenged by a security feature). Exact counts, not sampled.",
			...noZones,
		],
		errors,
	};
	return [cdn, good];
}

// ---------------------------------------------------------------------------
// DNS queries (authoritative DNS answered by Cloudflare for each zone)

async function dnsQueries(api: Api, zones: Zone[], range: DateRange): Promise<Section> {
	const perZone = await Promise.all(
		zones.map(async (z) => {
			const r = await zoneRows(api, z.id, "dnsAnalyticsAdaptiveGroups", "{ count dimensions { responseCode } }", range);
			const byCode = new Map<string, number>();
			for (const row of r.rows) {
				const code = String(get(row, "dimensions.responseCode") ?? "unknown");
				byCode.set(code, (byCode.get(code) ?? 0) + toNum(row.count));
			}
			const queries = [...byCode.values()].reduce((a, b) => a + b, 0);
			const noerror = byCode.get("NOERROR") ?? 0;
			const nxdomain = byCode.get("NXDOMAIN") ?? 0;
			return { zone: z, queries, noerror, nxdomain, other: queries - noerror - nxdomain, errors: r.errors.map((e) => `${z.name}: ${e}`) };
		}),
	);
	const sum = (k: "queries" | "noerror" | "nxdomain" | "other") => perZone.reduce((acc, z) => acc + z[k], 0);
	return {
		id: "dns",
		group: "Zones",
		title: "DNS queries",
		source: "dnsAnalyticsAdaptiveGroups",
		metrics: [
			{ label: "DNS queries", value: sum("queries"), unit: "count" },
			{ label: "Answered (NOERROR)", value: pct(sum("noerror"), sum("queries")), unit: "percent" },
			{ label: "Name not found (NXDOMAIN)", value: pct(sum("nxdomain"), sum("queries")), unit: "percent" },
			{ label: "Daily average", value: sum("queries") / Math.max(1, splitRange(range, 1).length), unit: "count" },
		],
		tables: [
			{
				title: "Per zone",
				columns: [
					{ key: "zone", label: "Zone" },
					{ key: "queries", label: "DNS queries", unit: "count" },
					{ key: "noerror", label: "NOERROR", unit: "count" },
					{ key: "nxdomain", label: "NXDOMAIN", unit: "count" },
					{ key: "other", label: "Other codes", unit: "count" },
					{ key: "nxPct", label: "NXDOMAIN %", unit: "percent" },
				],
				rows: [
					...perZone.map((z) => ({
						zone: z.zone.name,
						zoneId: z.zone.id,
						queries: z.queries,
						noerror: z.noerror,
						nxdomain: z.nxdomain,
						other: z.other,
						nxPct: pct(z.nxdomain, z.queries),
					})),
					{ zone: "Total", queries: sum("queries"), noerror: sum("noerror"), nxdomain: sum("nxdomain"), other: sum("other"), nxPct: pct(sum("nxdomain"), sum("queries")) },
				],
			},
		],
		notes: [
			"Sampled data: counts are estimates rounded to the nearest 100, so very small zones are approximate.",
			"Zones on a CNAME (partial) setup use another DNS provider and show 0.",
		],
		errors: perZone.flatMap((z) => z.errors),
	};
}

// ---------------------------------------------------------------------------
// Spectrum: IPv4 addresses, data transfer, connections (REST – not in GraphQL)

interface SpectrumApp {
	id: string;
	protocol: string;
	dns?: { name?: string };
	edge_ips?: { type?: string; connectivity?: string; ips?: string[] };
}

interface SpectrumSummary {
	totals?: { count?: number; bytesIngress?: number; bytesEgress?: number };
}

interface SpectrumCurrent {
	appID?: string;
	connections?: number;
	bytesIngress?: number;
	bytesEgress?: number;
}

async function spectrum(api: Api, zones: Zone[], range: DateRange): Promise<Section> {
	const errors: string[] = [];
	// Zones where the token may not read Spectrum apps (reported once, not per zone).
	const appsForbidden: string[] = [];
	const perZone = await Promise.all(
		zones.map(async (z) => {
			const row = {
				zone: z.name,
				apps: null as number | null,
				staticIpv4: null as number | null,
				dynamicIpv4Apps: null as number | null,
				connections: 0,
				bytesIngress: 0,
				bytesEgress: 0,
				currentConnections: null as number | null,
				ipv4List: [] as string[],
			};

			const appsTask = (async () => {
				try {
					const apps: SpectrumApp[] = [];
					for (let page = 1; ; page++) {
						const body = await rest<SpectrumApp[]>(api, `/zones/${z.id}/spectrum/apps?per_page=100&page=${page}`);
						apps.push(...body.result);
						if (isLastPage(body, page, 100)) break;
					}
					const staticV4 = new Set<string>();
					let dynamicV4 = 0;
					for (const a of apps) {
						const e = a.edge_ips ?? {};
						if (e.type === "static") for (const ip of e.ips ?? []) if (ip.includes(".")) staticV4.add(ip);
						if (e.type !== "static" && (e.connectivity ?? "all") !== "ipv6") dynamicV4++;
					}
					row.apps = apps.length;
					row.staticIpv4 = staticV4.size;
					row.dynamicIpv4Apps = dynamicV4;
					row.ipv4List = [...staticV4];
				} catch (err) {
					if (/HTTP 403/.test(message(err))) appsForbidden.push(z.name);
					else errors.push(`${z.name} apps (IPv4): ${message(err)}`);
				}
			})();

			const summaryTask = Promise.all(
				splitRange(range, 31).map(async (w) => {
					try {
						const body = await rest<SpectrumSummary>(
							api,
							`/zones/${z.id}/spectrum/analytics/events/summary?metrics=count,bytesIngress,bytesEgress&since=${w.from}T00:00:00Z&until=${untilFor(w.to)}`,
						);
						row.connections += body.result.totals?.count ?? 0;
						row.bytesIngress += body.result.totals?.bytesIngress ?? 0;
						row.bytesEgress += body.result.totals?.bytesEgress ?? 0;
					} catch (err) {
						errors.push(`${z.name} ${w.from} → ${w.to}: ${message(err)}`);
					}
				}),
			);

			const currentTask = (async () => {
				try {
					const body = await rest<SpectrumCurrent[] | null>(api, `/zones/${z.id}/spectrum/analytics/aggregate/current`);
					row.currentConnections = (body.result ?? []).reduce((acc, a) => acc + (a.connections ?? 0), 0);
				} catch (err) {
					errors.push(`${z.name} current connections: ${message(err)}`);
				}
			})();

			await Promise.all([appsTask, summaryTask, currentTask]);
			return row;
		}),
	);

	const s = (k: "connections" | "bytesIngress" | "bytesEgress") => perZone.reduce((acc, r) => acc + r[k], 0);
	const sNullable = (k: "staticIpv4" | "dynamicIpv4Apps" | "currentConnections") =>
		perZone.some((r) => r[k] !== null) ? perZone.reduce((acc, r) => acc + (r[k] ?? 0), 0) : null;
	const staticV4 = sNullable("staticIpv4");
	const dynamicV4 = sNullable("dynamicIpv4Apps");
	if (appsForbidden.length) {
		errors.unshift(
			`IPv4 count unavailable: the API token can't read Spectrum apps (${appsForbidden.join(", ")}). ` +
				"Edit the token in the Cloudflare dashboard and add Zone → Zone Settings → Read for these zones. " +
				"No redeploy needed: the token value stays the same.",
		);
	}

	return {
		id: "spectrum",
		group: "Zones",
		title: "Spectrum",
		source: "REST /spectrum/apps, /spectrum/analytics/events/summary, /aggregate/current",
		metrics: [
			{
				label: "IPv4 addresses",
				value: staticV4 === null && dynamicV4 === null ? null : (staticV4 ?? 0) + (dynamicV4 ?? 0),
				unit: "count",
				hint: appsForbidden.length === zones.length && zones.length ? "Needs token permission Zone Settings: Read" : "Static IPv4s plus one per dynamic-IP app",
			},
			{ label: "Data transfer (in + out)", value: s("bytesIngress") + s("bytesEgress"), unit: "bytes" },
			{ label: "Connections in range", value: s("connections"), unit: "count" },
			{ label: "Concurrent connections now", value: sNullable("currentConnections"), unit: "count" },
		],
		tables: [
			{
				title: "Per zone",
				columns: [
					{ key: "zone", label: "Zone" },
					{ key: "apps", label: "Apps", unit: "count" },
					{ key: "staticIpv4", label: "Static IPv4", unit: "count" },
					{ key: "dynamicIpv4Apps", label: "Dynamic-IPv4 apps", unit: "count" },
					{ key: "bytesIngress", label: "Ingress", unit: "bytes" },
					{ key: "bytesEgress", label: "Egress", unit: "bytes" },
					{ key: "connections", label: "Connections", unit: "count" },
					{ key: "currentConnections", label: "Concurrent now", unit: "count" },
				],
				rows: perZone.map(({ ipv4List: _ignored, ...r }) => ({ ...r, zoneId: zones.find((z) => z.name === r.zone)?.id ?? null })),
			},
		],
		notes: [
			"Cloudflare's API only exposes concurrent connections right now; there is no historical peak, so 'Connections in range' counts connections opened during the period.",
		],
		errors,
	};
}

function untilFor(to: string): string {
	// `until` is exclusive: use the start of the next day, or now if that is in the future.
	const next = Date.parse(`${to}T00:00:00Z`) + 86_400_000;
	const now = Date.now() - 60_000;
	return new Date(Math.min(next, now)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// Images: unique transformations

async function images(api: Api, range: DateRange): Promise<Section> {
	const [acc, daily] = await Promise.all([
		accountRows(api, "imagesUniqueTransformationsAccumulatedSinceStartOfMonth", "{ date transformations }", range),
		accountRows(api, "imagesUniqueTransformations", "{ date transformations }", range),
	]);

	// Billing counts unique transformations per calendar month: the running total on the month's last day.
	const byMonth = new Map<string, { date: string; value: number }>();
	for (const r of acc.rows) {
		const date = String(r.date);
		const value = toNum(r.transformations);
		const m = byMonth.get(date.slice(0, 7));
		if (!m || date > m.date) byMonth.set(date.slice(0, 7), { date, value });
	}
	const months = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b));
	const billable = months.reduce((s, [, m]) => s + m.value, 0);

	return {
		id: "images",
		group: "Media",
		title: "Images – unique transformations",
		source: "imagesUniqueTransformations, imagesUniqueTransformationsAccumulatedSinceStartOfMonth",
		metrics: [
			{ label: "Unique transformations (billable)", value: billable, unit: "count", hint: "Month-to-date total at the last day of each month in range" },
			{ label: "Months covered", value: months.length, unit: "count" },
		],
		tables: [
			{
				title: "By month",
				columns: [
					{ key: "month", label: "Month" },
					{ key: "asOf", label: "As of" },
					{ key: "transformations", label: "Unique transformations", unit: "count" },
				],
				rows: months.map(([month, m]) => ({ month, asOf: m.date, transformations: m.value })),
			},
			{
				title: "By day",
				columns: [
					{ key: "date", label: "Date" },
					{ key: "transformations", label: "Unique that day", unit: "count" },
				],
				rows: daily.rows
					.map((r) => ({ date: String(r.date), transformations: toNum(r.transformations) }))
					.sort((a, b) => a.date.localeCompare(b.date)),
			},
		],
		notes: [
			"Monthly totals always count from the 1st of the month, even if the selected range starts later.",
			...(acc.rows.length === 0 && acc.errors.length === 0 ? ["No image transformations in this range."] : []),
		],
		errors: [...acc.errors, ...daily.errors],
	};
}

// ---------------------------------------------------------------------------
// Developer platform

async function workers(api: Api, range: DateRange): Promise<Section> {
	const r = await accountRows(api, "workersInvocationsAdaptive", "{ sum { requests errors subrequests cpuTimeUs } dimensions { scriptName } }", range);
	const scripts = groupSum(r.rows, "dimensions.scriptName", ["sum.requests", "sum.errors", "sum.subrequests", "sum.cpuTimeUs"]);
	const top = [...scripts.entries()].sort((a, b) => b[1]["sum.requests"] - a[1]["sum.requests"]);
	return {
		id: "workers",
		group: "Developer platform",
		title: "Workers",
		source: "workersInvocationsAdaptive",
		metrics: [
			{ label: "Requests", value: total(r.rows, "sum.requests"), unit: "count" },
			{ label: "CPU time", value: total(r.rows, "sum.cpuTimeUs") / 1000, unit: "ms" },
			{ label: "Errors", value: total(r.rows, "sum.errors"), unit: "count" },
			{ label: "Subrequests", value: total(r.rows, "sum.subrequests"), unit: "count" },
		],
		tables: [
			{
				title: `By Worker (${top.length})`,
				columns: [
					{ key: "script", label: "Worker" },
					{ key: "requests", label: "Requests", unit: "count" },
					{ key: "cpu", label: "CPU time", unit: "ms" },
					{ key: "errors", label: "Errors", unit: "count" },
				],
				rows: top.map(([script, v]) => ({ script, requests: v["sum.requests"], cpu: v["sum.cpuTimeUs"] / 1000, errors: v["sum.errors"] })),
			},
		],
		notes: ["Sampled data: counts are close estimates, not exact billing figures."],
		errors: r.errors,
	};
}

async function kv(api: Api, range: DateRange): Promise<Section> {
	const [ops, storage] = await Promise.all([
		accountRows(api, "kvOperationsAdaptiveGroups", "{ sum { requests } dimensions { actionType } }", range),
		accountRows(api, "kvStorageAdaptiveGroups", "{ max { byteCount keyCount } dimensions { namespaceId date } }", range),
	]);
	const byAction = groupSum(ops.rows, "dimensions.actionType", ["sum.requests"]);
	const op = (a: string) => byAction.get(a)?.["sum.requests"] ?? 0;
	const bytes = dailyTotals(storage.rows, "max.byteCount");
	const keys = dailyTotals(storage.rows, "max.keyCount");
	return {
		id: "kv",
		group: "Developer platform",
		title: "Workers KV",
		source: "kvOperationsAdaptiveGroups, kvStorageAdaptiveGroups",
		metrics: [
			{ label: "Reads", value: op("read"), unit: "count" },
			{ label: "Writes", value: op("write"), unit: "count" },
			{ label: "Deletes", value: op("delete"), unit: "count" },
			{ label: "Lists", value: op("list"), unit: "count" },
			{ label: "Storage (end of range)", value: bytes.end, unit: "bytes" },
			{ label: "Storage (peak)", value: bytes.peak, unit: "bytes" },
			{ label: "Keys (end of range)", value: keys.end, unit: "count" },
			{ label: "Namespaces", value: distinct(storage.rows, "dimensions.namespaceId"), unit: "count" },
		],
		tables: [opsTable(byAction)],
		notes: [],
		errors: [...ops.errors, ...storage.errors],
	};
}

async function d1(api: Api, range: DateRange): Promise<Section> {
	const [q, storage] = await Promise.all([
		accountRows(api, "d1AnalyticsAdaptiveGroups", "{ sum { readQueries writeQueries rowsRead rowsWritten } }", range),
		accountRows(api, "d1StorageAdaptiveGroups", "{ max { databaseSizeBytes } dimensions { databaseId date } }", range),
	]);
	const size = dailyTotals(storage.rows, "max.databaseSizeBytes");
	return {
		id: "d1",
		group: "Developer platform",
		title: "D1",
		source: "d1AnalyticsAdaptiveGroups, d1StorageAdaptiveGroups",
		metrics: [
			{ label: "Rows read", value: total(q.rows, "sum.rowsRead"), unit: "count" },
			{ label: "Rows written", value: total(q.rows, "sum.rowsWritten"), unit: "count" },
			{ label: "Read queries", value: total(q.rows, "sum.readQueries"), unit: "count" },
			{ label: "Write queries", value: total(q.rows, "sum.writeQueries"), unit: "count" },
			{ label: "Storage (end of range)", value: size.end, unit: "bytes" },
			{ label: "Storage (peak)", value: size.peak, unit: "bytes" },
			{ label: "Databases", value: distinct(storage.rows, "dimensions.databaseId"), unit: "count" },
		],
		tables: [],
		notes: [],
		errors: [...q.errors, ...storage.errors],
	};
}

async function durableObjects(api: Api, range: DateRange): Promise<Section> {
	const [inv, periodic, kvStore, sqlStore] = await Promise.all([
		accountRows(api, "durableObjectsInvocationsAdaptiveGroups", "{ sum { requests errors } dimensions { scriptName } }", range),
		accountRows(
			api,
			"durableObjectsPeriodicGroups",
			"{ sum { duration cpuTime rowsRead rowsWritten storageReadUnits storageWriteUnits storageDeletes inboundWebsocketMsgCount outboundWebsocketMsgCount } max { activeWebsocketConnections } }",
			range,
		),
		accountRows(api, "durableObjectsStorageGroups", "{ max { storedBytes } dimensions { date } }", range),
		accountRows(api, "durableObjectsSqlStorageGroups", "{ max { storedBytes } dimensions { namespaceId date } }", range),
	]);
	const kvBytes = dailyTotals(kvStore.rows, "max.storedBytes");
	const sqlBytes = dailyTotals(sqlStore.rows, "max.storedBytes");
	const byScript = groupSum(inv.rows, "dimensions.scriptName", ["sum.requests", "sum.errors"]);
	return {
		id: "durable-objects",
		group: "Developer platform",
		title: "Durable Objects",
		source: "durableObjectsInvocationsAdaptiveGroups, durableObjectsPeriodicGroups, durableObjects(Sql)StorageGroups",
		metrics: [
			{ label: "Requests", value: total(inv.rows, "sum.requests"), unit: "count" },
			{ label: "Duration", value: total(periodic.rows, "sum.duration"), unit: "gbSeconds" },
			{ label: "Errors", value: total(inv.rows, "sum.errors"), unit: "count" },
			{ label: "CPU time", value: total(periodic.rows, "sum.cpuTime") / 1000, unit: "ms" },
			{ label: "SQL rows read", value: total(periodic.rows, "sum.rowsRead"), unit: "count" },
			{ label: "SQL rows written", value: total(periodic.rows, "sum.rowsWritten"), unit: "count" },
			{ label: "KV storage read units (4 KB)", value: total(periodic.rows, "sum.storageReadUnits"), unit: "count" },
			{ label: "KV storage write units (4 KB)", value: total(periodic.rows, "sum.storageWriteUnits"), unit: "count" },
			{ label: "KV storage deletes", value: total(periodic.rows, "sum.storageDeletes"), unit: "count" },
			{ label: "WebSocket messages in", value: total(periodic.rows, "sum.inboundWebsocketMsgCount"), unit: "count" },
			{ label: "Peak WebSocket connections", value: maxOf(periodic.rows, "max.activeWebsocketConnections"), unit: "count" },
			{ label: "SQL storage (end of range)", value: sqlBytes.end, unit: "bytes" },
			{ label: "KV storage (end of range)", value: kvBytes.end, unit: "bytes" },
		],
		tables: [
			{
				title: "By Worker",
				columns: [
					{ key: "script", label: "Worker" },
					{ key: "requests", label: "Requests", unit: "count" },
					{ key: "errors", label: "Errors", unit: "count" },
				],
				rows: [...byScript.entries()]
					.sort((a, b) => b[1]["sum.requests"] - a[1]["sum.requests"])
					.map(([script, v]) => ({ script, requests: v["sum.requests"], errors: v["sum.errors"] })),
			},
		],
		notes: ["Requests and duration are sampled estimates."],
		errors: [...inv.errors, ...periodic.errors, ...kvStore.errors, ...sqlStore.errors],
	};
}

async function containers(api: Api, range: DateRange): Promise<Section> {
	const r = await accountRows(api, "containersUsageAdaptiveGroups", "{ sum { cpuTimeSec allocatedMemory allocatedDisk txBytes } }", range);
	return {
		id: "containers",
		group: "Developer platform",
		title: "Containers",
		source: "containersUsageAdaptiveGroups",
		metrics: [
			{ label: "vCPU time", value: total(r.rows, "sum.cpuTimeSec"), unit: "seconds" },
			{ label: "Memory", value: total(r.rows, "sum.allocatedMemory") / 2 ** 30, unit: "gibSeconds" },
			{ label: "Disk", value: total(r.rows, "sum.allocatedDisk") / 1e9, unit: "gbSeconds" },
			{ label: "Egress", value: total(r.rows, "sum.txBytes"), unit: "bytes" },
		],
		tables: [],
		notes: ["Memory and disk are allocated amounts over time, which is what Containers bills on."],
		errors: r.errors,
	};
}

async function queues(api: Api, range: DateRange): Promise<Section> {
	const r = await accountRows(api, "queueMessageOperationsAdaptiveGroups", "{ sum { billableOperations bytes } dimensions { actionType } }", range);
	const byAction = groupSum(r.rows, "dimensions.actionType", ["sum.billableOperations"]);
	return {
		id: "queues",
		group: "Developer platform",
		title: "Queues",
		source: "queueMessageOperationsAdaptiveGroups",
		metrics: [
			{ label: "Billable operations", value: total(r.rows, "sum.billableOperations"), unit: "count", hint: "Each 64 KB of a write, read or delete counts as one" },
			{ label: "Message bytes", value: total(r.rows, "sum.bytes"), unit: "bytes" },
		],
		tables: [
			{
				title: "By operation",
				columns: [
					{ key: "action", label: "Operation" },
					{ key: "ops", label: "Billable operations", unit: "count" },
				],
				rows: [...byAction.entries()].map(([action, v]) => ({ action, ops: v["sum.billableOperations"] })),
			},
		],
		notes: [],
		errors: r.errors,
	};
}

async function workflows(api: Api, range: DateRange): Promise<Section> {
	const r = await accountRows(api, "workflowsAdaptiveGroups", "{ count sum { stepCount cpuTime wallTime executionDuration } dimensions { eventType } }", range);
	const byEvent = new Map<string, number>();
	for (const row of r.rows) {
		const k = String(get(row, "dimensions.eventType") ?? "unknown");
		byEvent.set(k, (byEvent.get(k) ?? 0) + toNum(row.count));
	}
	return {
		id: "workflows",
		group: "Developer platform",
		title: "Workflows",
		source: "workflowsAdaptiveGroups",
		metrics: [
			{ label: "Instances started", value: byEvent.get("WORKFLOW_START") ?? 0, unit: "count" },
			{ label: "Steps (step.do)", value: total(r.rows, "sum.stepCount"), unit: "count" },
			{ label: "CPU time", value: total(r.rows, "sum.cpuTime"), unit: "ms" },
			{ label: "Execution duration", value: total(r.rows, "sum.executionDuration"), unit: "gbSeconds" },
			{ label: "Succeeded", value: byEvent.get("WORKFLOW_SUCCESS") ?? 0, unit: "count" },
			{ label: "Failed", value: byEvent.get("WORKFLOW_FAILURE") ?? 0, unit: "count" },
		],
		tables: [
			{
				title: "By event type",
				columns: [
					{ key: "event", label: "Event" },
					{ key: "count", label: "Count", unit: "count" },
				],
				rows: [...byEvent.entries()].sort((a, b) => b[1] - a[1]).map(([event, count]) => ({ event, count })),
			},
		],
		notes: ["Cloudflare keeps Workflows analytics for only 31 days."],
		errors: r.errors,
	};
}

async function pages(api: Api, range: DateRange): Promise<Section> {
	const r = await accountRows(api, "pagesFunctionsInvocationsAdaptiveGroups", "{ sum { requests errors subrequests duration } dimensions { scriptName } }", range);
	const byScript = groupSum(r.rows, "dimensions.scriptName", ["sum.requests", "sum.errors"]);
	return {
		id: "pages",
		group: "Developer platform",
		title: "Pages Functions",
		source: "pagesFunctionsInvocationsAdaptiveGroups",
		metrics: [
			{ label: "Requests", value: total(r.rows, "sum.requests"), unit: "count" },
			{ label: "Errors", value: total(r.rows, "sum.errors"), unit: "count" },
			{ label: "Subrequests", value: total(r.rows, "sum.subrequests"), unit: "count" },
			{ label: "Duration", value: total(r.rows, "sum.duration"), unit: "gbSeconds" },
		],
		tables: [
			{
				title: "By project",
				columns: [
					{ key: "script", label: "Project" },
					{ key: "requests", label: "Requests", unit: "count" },
					{ key: "errors", label: "Errors", unit: "count" },
				],
				rows: [...byScript.entries()]
					.sort((a, b) => b[1]["sum.requests"] - a[1]["sum.requests"])
					.map(([script, v]) => ({ script, requests: v["sum.requests"], errors: v["sum.errors"] })),
			},
		],
		notes: ["Static asset requests on Pages are free and not counted here."],
		errors: r.errors,
	};
}

// R2 pricing classes: https://developers.cloudflare.com/r2/pricing/
const R2_CLASS_B = new Set([
	"HeadBucket", "HeadObject", "GetObject", "UsageSummary", "GetBucketEncryption", "GetBucketLocation",
	"GetBucketCors", "GetBucketLifecycleConfiguration",
]);
const R2_FREE = new Set(["DeleteObject", "DeleteBucket", "AbortMultipartUpload"]);

async function r2(api: Api, range: DateRange): Promise<Section> {
	const [ops, storage, bw] = await Promise.all([
		accountRows(api, "r2OperationsAdaptiveGroups", "{ sum { requests } dimensions { actionType } }", range),
		accountRows(api, "r2StorageAdaptiveGroups", "{ max { payloadSize metadataSize objectCount } dimensions { bucketName storageClass date } }", range),
		accountRows(api, "r2BandwidthUsageAdaptiveGroups", "{ sum { bytesDownload bytesUpload } }", range),
	]);
	const byAction = groupSum(ops.rows, "dimensions.actionType", ["sum.requests"]);
	let classA = 0;
	let classB = 0;
	let free = 0;
	for (const [action, v] of byAction) {
		if (R2_FREE.has(action)) free += v["sum.requests"];
		else if (R2_CLASS_B.has(action)) classB += v["sum.requests"];
		else classA += v["sum.requests"];
	}

	const classes = [...new Set(storage.rows.map((r) => String(get(r, "dimensions.storageClass"))))].sort();
	const storageRows = classes.map((cls) => {
		const rows = storage.rows.filter((r) => String(get(r, "dimensions.storageClass")) === cls);
		const withTotal = rows.map((r) => ({ ...r, _bytes: toNum(get(r, "max.payloadSize")) + toNum(get(r, "max.metadataSize")) }));
		const b = dailyTotals(withTotal, "_bytes");
		const o = dailyTotals(rows, "max.objectCount");
		return { storageClass: cls, end: b.end, peak: b.peak, objects: o.end };
	});
	const std = storageRows.find((r) => r.storageClass === "Standard");
	const ia = storageRows.find((r) => r.storageClass === "InfrequentAccess");

	return {
		id: "r2",
		group: "Developer platform",
		title: "R2",
		source: "r2OperationsAdaptiveGroups, r2StorageAdaptiveGroups, r2BandwidthUsageAdaptiveGroups",
		metrics: [
			{ label: "Class A operations", value: classA, unit: "count", hint: "Writes and lists" },
			{ label: "Class B operations", value: classB, unit: "count", hint: "Reads" },
			{ label: "Free operations (deletes)", value: free, unit: "count" },
			{ label: "Standard storage (end of range)", value: std?.end ?? 0, unit: "bytes" },
			{ label: "Infrequent Access storage (end)", value: ia?.end ?? 0, unit: "bytes" },
			{ label: "Objects (Standard, end)", value: std?.objects ?? 0, unit: "count" },
			{ label: "Uploaded", value: total(bw.rows, "sum.bytesUpload"), unit: "bytes", hint: "Estimate; transfers under 100 KiB excluded" },
			{ label: "Downloaded", value: total(bw.rows, "sum.bytesDownload"), unit: "bytes", hint: "R2 egress is free" },
		],
		tables: [
			{
				title: "Storage by class",
				columns: [
					{ key: "storageClass", label: "Storage class" },
					{ key: "end", label: "End of range", unit: "bytes" },
					{ key: "peak", label: "Peak", unit: "bytes" },
					{ key: "objects", label: "Objects (end)", unit: "count" },
				],
				rows: storageRows,
			},
			opsTable(byAction),
		],
		notes: [],
		errors: [...ops.errors, ...storage.errors, ...bw.errors],
	};
}

// ---------------------------------------------------------------------------
// Helpers

function failedSection(id: string, err: unknown): Section {
	return { id, group: "Developer platform", title: id, source: "", metrics: [], tables: [], notes: [], errors: [message(err)] };
}

function opsTable(byAction: Map<string, Record<string, number>>): Table {
	return {
		title: "By operation",
		columns: [
			{ key: "action", label: "Operation" },
			{ key: "requests", label: "Requests", unit: "count" },
		],
		rows: [...byAction.entries()]
			.sort((a, b) => b[1]["sum.requests"] - a[1]["sum.requests"])
			.map(([action, v]) => ({ action, requests: v["sum.requests"] })),
	};
}

function get(row: Row, path: string): unknown {
	let cur: unknown = row;
	for (const part of path.split(".")) {
		if (cur === null || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[part];
	}
	return cur;
}

function toNum(v: unknown): number {
	const n = typeof v === "number" ? v : Number(v);
	return Number.isFinite(n) ? n : 0;
}

function total(rows: Row[], path: string): number {
	return rows.reduce((acc, r) => acc + toNum(get(r, path)), 0);
}

function maxOf(rows: Row[], path: string): number {
	return rows.reduce((acc, r) => Math.max(acc, toNum(get(r, path))), 0);
}

function distinct(rows: Row[], path: string): number {
	return new Set(rows.map((r) => String(get(r, path)))).size;
}

function groupSum(rows: Row[], keyPath: string, fields: string[]): Map<string, Record<string, number>> {
	const out = new Map<string, Record<string, number>>();
	for (const r of rows) {
		const k = String(get(r, keyPath) ?? "unknown");
		const acc = out.get(k) ?? Object.fromEntries(fields.map((f) => [f, 0]));
		for (const f of fields) acc[f] += toNum(get(r, f));
		out.set(k, acc);
	}
	return out;
}

/**
 * Storage datasets report a value per entity per day. Sum across entities for
 * each day, then return the last day's total and the highest daily total.
 */
function dailyTotals(rows: Row[], path: string): { end: number; peak: number } {
	const byDate = new Map<string, number>();
	for (const r of rows) {
		const d = String(get(r, "dimensions.date") ?? "");
		byDate.set(d, (byDate.get(d) ?? 0) + toNum(get(r, path)));
	}
	if (byDate.size === 0) return { end: 0, peak: 0 };
	const dates = [...byDate.keys()].sort();
	return { end: byDate.get(dates[dates.length - 1]) ?? 0, peak: Math.max(...byDate.values()) };
}

function pct(part: number, whole: number): number | null {
	return whole > 0 ? (part / whole) * 100 : null;
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
