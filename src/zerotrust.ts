/**
 * Zero Trust (Cloudflare One) usage: Access, Gateway, Shadow IT, MCP, WARP, Tunnels,
 * Browser Isolation, private network discovery and the remaining sampled datasets.
 *
 * Each dataset is fetched with one GraphQL request (several aliases), so the whole page
 * costs about 15 subrequests per window.
 */

import { accountAliases, splitRange, type AliasQuery, type Api, type DateRange, type Row } from "./cloudflare";
import type { Column, Metric, Section, Table, Unit } from "./usage";

const TOP = 10;
// `cf1…1d` rollups allow 90-day windows; adaptive datasets ~31 days.
const DAILY = { maxDays: 90 };
const ADAPTIVE = { maxDays: 31 };

export async function buildZeroTrust(api: Api, range: DateRange): Promise<Section[]> {
	const builders: [string, () => Promise<Section>][] = [
		["zt-access", () => access(api, range)],
		["zt-dns", () => gatewayDns(api, range)],
		["zt-http", () => gatewayHttp(api, range)],
		["zt-network", () => gatewayNetwork(api, range)],
		["zt-sessions", () => networkSessions(api, range)],
		["zt-shadow-it", () => shadowIt(api, range)],
		["zt-mcp", () => mcp(api, range)],
		["zt-warp", () => warp(api, range)],
		["zt-tunnels", () => tunnels(api, range)],
		["zt-isolation", () => isolation(api, range)],
		["zt-discovery", () => discovery(api, range)],
		["zt-other", () => otherDatasets(api, range)],
	];
	const settled = await Promise.allSettled(builders.map(([, fn]) => fn()));
	return settled.map((s, i) =>
		s.status === "fulfilled"
			? s.value
			: { id: builders[i][0], group: "Zero Trust", title: builders[i][0], source: "", metrics: [], tables: [], notes: [], errors: [String(s.reason)] },
	);
}

// ---------------------------------------------------------------------------
// Access

async function access(api: Api, range: DateRange): Promise<Section> {
	const ds = "cf1AccessLogins1dGroups";
	const by = (dim: string): AliasQuery => ({ selection: `{ sum { logins } uniq { users } dimensions { ${dim} } }`, orderBy: "sum_logins_DESC", limit: 200 });
	const [logins, requests] = await Promise.all([
		accountAliases(api, ds, {
			tot: { selection: "{ sum { logins } uniq { users } }", limit: 1 },
			app: by("appName"), allowed: by("allowed"), idp: by("idp"), country: by("country"), type: by("loginType"),
		}, range, DAILY),
		accountAliases(api, "accessLoginRequestsAdaptiveGroups", {
			ok: { selection: "{ count dimensions { isSuccessfulLogin } }", limit: 10 },
		}, range, ADAPTIVE),
	]);
	const r = logins.rows;
	const denied = sumWhere(r.allowed, "dimensions.allowed", (v) => v === false || v === "false" || v === 0, "sum.logins");
	const reqTotal = total(requests.rows.ok, "count");
	const reqFailed = sumWhere(requests.rows.ok, "dimensions.isSuccessfulLogin", (v) => v === false || v === 0 || v === "false", "count");
	return section("zt-access", "Access", "Access logins", `${ds}, accessLoginRequestsAdaptiveGroups`, [
		m("Logins", total(r.tot, "sum.logins")),
		m("Unique users", maxOf(r.tot, "uniq.users"), "count", multiWindow(range, 90)),
		m("Denied logins", denied),
		m("Login requests (sampled)", reqTotal),
		m("Failed login requests (sampled)", reqFailed),
	], [
		table("By application", r.app, "dimensions.appName", "Application", [["sum.logins", "Logins"], ["uniq.users", "Users", "max"]]),
		table("Allowed vs denied", r.allowed, "dimensions.allowed", "Allowed", [["sum.logins", "Logins"]], (k) => (k === "true" ? "Allowed" : k === "false" ? "Denied" : k)),
		table("By identity provider", r.idp, "dimensions.idp", "Identity provider", [["sum.logins", "Logins"], ["uniq.users", "Users", "max"]]),
		table("By login type", r.type, "dimensions.loginType", "Login type", [["sum.logins", "Logins"]]),
		table("By country", r.country, "dimensions.country", "Country", [["sum.logins", "Logins"]]),
	], [...logins.errors, ...requests.errors]);
}

// ---------------------------------------------------------------------------
// Gateway

async function gatewayDns(api: Api, range: DateRange): Promise<Section> {
	const ds = "cf1GatewayDns1dGroups";
	const by = (dim: string): AliasQuery => ({ selection: `{ sum { queries } dimensions { ${dim} } }`, orderBy: "sum_queries_DESC", limit: 200 });
	const res = await accountAliases(api, ds, {
		tot: { selection: "{ sum { queries queryBytes responseBytes } uniq { users devices } }", limit: 1 },
		decision: by("resolverDecision"), qtype: by("queryType"), rcode: by("rcode"), location: by("location"), country: by("country"), policy: by("policyId"),
	}, range, DAILY);
	const r = res.rows;
	return section("zt-dns", "Gateway", "Gateway DNS", ds, [
		m("DNS queries", total(r.tot, "sum.queries")),
		m("Query + response bytes", total(r.tot, "sum.queryBytes") + total(r.tot, "sum.responseBytes"), "bytes"),
		m("Unique users", maxOf(r.tot, "uniq.users"), "count", multiWindow(range, 90)),
		m("Unique devices", maxOf(r.tot, "uniq.devices")),
	], [
		table("By resolver decision", r.decision, "dimensions.resolverDecision", "Decision", [["sum.queries", "Queries"]], resolverDecision),
		table("By query type", r.qtype, "dimensions.queryType", "Query type", [["sum.queries", "Queries"]]),
		table("By response code", r.rcode, "dimensions.rcode", "Response code", [["sum.queries", "Queries"]]),
		table("By location", r.location, "dimensions.location", "Location", [["sum.queries", "Queries"]]),
		table("By policy", r.policy, "dimensions.policyId", "Policy ID", [["sum.queries", "Queries"]]),
		table("By country", r.country, "dimensions.country", "Country", [["sum.queries", "Queries"]]),
	], res.errors);
}

async function gatewayHttp(api: Api, range: DateRange): Promise<Section> {
	const ds = "cf1GatewayHttp1dGroups";
	const by = (dim: string): AliasQuery => ({ selection: `{ sum { requests bodyBytesSent bodyBytesRcvd } dimensions { ${dim} } }`, orderBy: "sum_requests_DESC", limit: 200 });
	const res = await accountAliases(api, ds, {
		tot: {
			selection: `{ sum { requests bodyBytesSent bodyBytesRcvd dlpScannedRequestsTotal dlpMatchedRequestsTotal dlpProfileMatchesTotal
				filesScanned avBlockedFiles sandboxScans sandboxBlocks isolatedRequests mcpUrlCountTotal } uniq { users applications } }`,
			limit: 1,
		},
		action: by("action"), host: by("httpHost"), country: by("country"), av: by("avResult"),
	}, range, DAILY);
	const r = res.rows;
	const bytes = (a: Row[]) => total(a, "sum.bodyBytesSent") + total(a, "sum.bodyBytesRcvd");
	return section("zt-http", "Gateway", "Gateway HTTP", ds, [
		m("HTTP requests", total(r.tot, "sum.requests")),
		m("Data (sent + received)", bytes(r.tot), "bytes"),
		m("Unique users", maxOf(r.tot, "uniq.users"), "count", multiWindow(range, 90)),
		m("Applications seen", maxOf(r.tot, "uniq.applications")),
		m("DLP scanned requests", total(r.tot, "sum.dlpScannedRequestsTotal")),
		m("DLP matched requests", total(r.tot, "sum.dlpMatchedRequestsTotal")),
		m("DLP profile matches", total(r.tot, "sum.dlpProfileMatchesTotal")),
		m("Files scanned (AV)", total(r.tot, "sum.filesScanned")),
		m("Files blocked (AV)", total(r.tot, "sum.avBlockedFiles")),
		m("Sandbox scans", total(r.tot, "sum.sandboxScans")),
		m("Sandbox blocks", total(r.tot, "sum.sandboxBlocks")),
		m("Isolated requests", total(r.tot, "sum.isolatedRequests")),
		m("MCP URLs", total(r.tot, "sum.mcpUrlCountTotal")),
	], [
		table("By action", r.action, "dimensions.action", "Action", [["sum.requests", "Requests"], ["sum.bodyBytesSent", "Sent", "sum", "bytes"], ["sum.bodyBytesRcvd", "Received", "sum", "bytes"]]),
		table("Top hosts", r.host, "dimensions.httpHost", "Host", [["sum.requests", "Requests"], ["sum.bodyBytesRcvd", "Received", "sum", "bytes"]]),
		table("Antivirus result", r.av, "dimensions.avResult", "Result", [["sum.requests", "Requests"]]),
		table("By country", r.country, "dimensions.country", "Country", [["sum.requests", "Requests"]]),
	], res.errors);
}

async function gatewayNetwork(api: Api, range: DateRange): Promise<Section> {
	const ds = "cf1GatewayNetwork1dGroups";
	const by = (dim: string): AliasQuery => ({ selection: `{ sum { requests } uniq { sessions } dimensions { ${dim} } }`, orderBy: "sum_requests_DESC", limit: 200 });
	const res = await accountAliases(api, ds, {
		tot: { selection: "{ sum { requests } uniq { sessions users devices } }", limit: 1 },
		action: by("action"), transport: by("transport"), sni: by("sni"), dst: by("destinationCountry"), rule: by("ruleId"),
	}, range, DAILY);
	const r = res.rows;
	return section("zt-network", "Gateway", "Gateway network (L4 firewall)", ds, [
		m("Network events", total(r.tot, "sum.requests")),
		m("Sessions", maxOf(r.tot, "uniq.sessions")),
		m("Unique users", maxOf(r.tot, "uniq.users"), "count", multiWindow(range, 90)),
		m("Unique devices", maxOf(r.tot, "uniq.devices")),
	], [
		table("By action", r.action, "dimensions.action", "Action", [["sum.requests", "Events"]]),
		table("By transport", r.transport, "dimensions.transport", "Transport", [["sum.requests", "Events"]]),
		table("Top SNI", r.sni, "dimensions.sni", "SNI", [["sum.requests", "Events"]]),
		table("By rule", r.rule, "dimensions.ruleId", "Rule ID", [["sum.requests", "Events"]]),
		table("By destination country", r.dst, "dimensions.destinationCountry", "Country", [["sum.requests", "Events"]]),
	], res.errors);
}

async function networkSessions(api: Api, range: DateRange): Promise<Section> {
	const ds = "cf1GatewayNetworkSession1dGroups";
	const by = (dim: string): AliasQuery => ({ selection: `{ sum { sessions bytesTotal } dimensions { ${dim} } }`, orderBy: "sum_sessions_DESC", limit: 200 });
	const res = await accountAliases(api, ds, {
		tot: { selection: "{ sum { sessions bytesTotal bytesUpload bytesDownload } avg { tcpHandshakeMs } uniq { users devices } }", limit: 1 },
		proto: by("protocol"), egress: by("egressIPv4"), onramp: by("onRamp"), close: by("connectionCloseReason"), country: by("sourceCountry"),
	}, range, DAILY);
	const r = res.rows;
	return section("zt-sessions", "Gateway", "Gateway network sessions (proxied traffic)", ds, [
		m("Sessions", total(r.tot, "sum.sessions")),
		m("Data transferred", total(r.tot, "sum.bytesTotal"), "bytes"),
		m("Upload", total(r.tot, "sum.bytesUpload"), "bytes"),
		m("Download", total(r.tot, "sum.bytesDownload"), "bytes"),
		m("Avg TCP handshake", weightedAvg(r.tot, "avg.tcpHandshakeMs", "sum.sessions"), "ms"),
		m("Unique users", maxOf(r.tot, "uniq.users"), "count", multiWindow(range, 90)),
		m("Unique devices", maxOf(r.tot, "uniq.devices")),
	], [
		table("By protocol", r.proto, "dimensions.protocol", "Protocol", [["sum.sessions", "Sessions"], ["sum.bytesTotal", "Data", "sum", "bytes"]]),
		table("By egress IPv4", r.egress, "dimensions.egressIPv4", "Egress IP", [["sum.sessions", "Sessions"], ["sum.bytesTotal", "Data", "sum", "bytes"]]),
		table("By on-ramp", r.onramp, "dimensions.onRamp", "On-ramp", [["sum.sessions", "Sessions"]]),
		table("Connection close reason", r.close, "dimensions.connectionCloseReason", "Reason", [["sum.sessions", "Sessions"]]),
		table("By source country", r.country, "dimensions.sourceCountry", "Country", [["sum.sessions", "Sessions"]]),
	], res.errors);
}

async function shadowIt(api: Api, range: DateRange): Promise<Section> {
	const ds = "shadowIt1hGroups";
	const by = (dim: string): AliasQuery => ({ selection: `{ sum { requests } uniq { users } dimensions { ${dim} } }`, orderBy: "sum_requests_DESC", limit: 200 });
	const res = await accountAliases(api, ds, {
		tot: { selection: "{ sum { requests bodyBytesSent bodyBytesRcvd } uniq { applications users } }", limit: 1 },
		status: by("applicationStatus"), app: by("applicationId"), host: by("httpHost"),
	}, range, DAILY);
	const r = res.rows;
	return section("zt-shadow-it", "Gateway", "Shadow IT (applications seen)", ds, [
		m("Requests", total(r.tot, "sum.requests")),
		m("Applications", maxOf(r.tot, "uniq.applications")),
		m("Users", maxOf(r.tot, "uniq.users"), "count", multiWindow(range, 90)),
		m("Data (sent + received)", total(r.tot, "sum.bodyBytesSent") + total(r.tot, "sum.bodyBytesRcvd"), "bytes"),
	], [
		table("By approval status", r.status, "dimensions.applicationStatus", "Status", [["sum.requests", "Requests"], ["uniq.users", "Users", "max"]]),
		table("By application ID", r.app, "dimensions.applicationId", "Application ID", [["sum.requests", "Requests"], ["uniq.users", "Users", "max"]]),
		table("Top hosts", r.host, "dimensions.httpHost", "Host", [["sum.requests", "Requests"]]),
	], res.errors);
}

async function mcp(api: Api, range: DateRange): Promise<Section> {
	const ds = "cf1McpHost1dGroups";
	const res = await accountAliases(api, ds, {
		tot: { selection: "{ sum { mcpUrlCount } uniq { mcpDistinctUsers } }", limit: 1 },
		host: { selection: "{ sum { mcpUrlCount } uniq { mcpDistinctUsers } dimensions { httpHost } }", orderBy: "sum_mcpUrlCount_DESC", limit: 200 },
	}, range, DAILY);
	const r = res.rows;
	return section("zt-mcp", "Gateway", "MCP servers (AI agents traffic)", ds, [
		m("MCP URL requests", total(r.tot, "sum.mcpUrlCount")),
		m("Distinct users", maxOf(r.tot, "uniq.mcpDistinctUsers"), "count", multiWindow(range, 90)),
	], [
		table("By MCP host", r.host, "dimensions.httpHost", "Host", [["sum.mcpUrlCount", "Requests"], ["uniq.mcpDistinctUsers", "Users", "max"]]),
	], res.errors);
}

// ---------------------------------------------------------------------------
// Devices & networks

async function warp(api: Api, range: DateRange): Promise<Section> {
	const ds = "warpDeviceAdaptiveGroups";
	const by = (dim: string): AliasQuery => ({ selection: `{ count uniq { deviceIds } dimensions { ${dim} } }`, orderBy: "count_DESC", limit: 200 });
	const res = await accountAliases(api, ds, {
		tot: { selection: "{ count uniq { deviceIds } }", limit: 1 },
		platform: by("clientPlatform"), version: by("clientVersion"), status: by("status"), mode: by("mode"), colo: by("colo"),
	}, range, ADAPTIVE);
	const r = res.rows;
	const cols: Spec[] = [["uniq.deviceIds", "Devices", "max"], ["count", "Health events"]];
	return section("zt-warp", "Devices & networks", "WARP devices", ds, [
		m("Devices", maxOf(r.tot, "uniq.deviceIds"), "count", multiWindow(range, 31)),
		m("Health events (sampled)", total(r.tot, "count")),
	], [
		table("By platform", r.platform, "dimensions.clientPlatform", "Platform", cols),
		table("By client version", r.version, "dimensions.clientVersion", "Version", cols),
		table("By status", r.status, "dimensions.status", "Status", cols),
		table("By mode", r.mode, "dimensions.mode", "Mode", cols),
		table("By data center", r.colo, "dimensions.colo", "Data center", cols),
	], res.errors);
}

async function tunnels(api: Api, range: DateRange): Promise<Section> {
	const ds = "cloudflareTunnelsAnalyticsAdaptiveGroups";
	const by = (dim: string): AliasQuery => ({ selection: `{ sum { bits egressBits } dimensions { ${dim} } }`, orderBy: "sum_bits_DESC", limit: 200 });
	const res = await accountAliases(api, ds, {
		tot: { selection: "{ sum { bits egressBits } }", limit: 1 },
		device: by("deviceName"), proto: by("protocol"), dst: by("destinationCountry"),
	}, range, ADAPTIVE);
	const r = res.rows;
	const toBytes = (rows: Row[]) => rows.map((x) => ({ ...x, _in: num(get(x, "sum.bits")) / 8, _out: num(get(x, "sum.egressBits")) / 8 }));
	const cols: Spec[] = [["_in", "Traffic", "sum", "bytes"], ["_out", "Egress", "sum", "bytes"]];
	return section("zt-tunnels", "Devices & networks", "Cloudflare Tunnel", ds, [
		m("Traffic", total(r.tot, "sum.bits") / 8, "bytes"),
		m("Egress", total(r.tot, "sum.egressBits") / 8, "bytes"),
	], [
		table("By device", toBytes(r.device), "dimensions.deviceName", "Device", cols),
		table("By protocol", toBytes(r.proto), "dimensions.protocol", "Protocol", cols),
		table("By destination country", toBytes(r.dst), "dimensions.destinationCountry", "Country", cols),
	], res.errors);
}

async function isolation(api: Api, range: DateRange): Promise<Section> {
	const [sessions, actions] = await Promise.all([
		accountAliases(api, "browserIsolationSessionsAdaptiveGroups", { tot: { selection: "{ count }", limit: 1 } }, range, ADAPTIVE),
		accountAliases(api, "browserIsolationUserActionsAdaptiveGroups", {
			type: { selection: "{ count dimensions { type decision } }", orderBy: "count_DESC", limit: 200 },
		}, range, ADAPTIVE),
	]);
	const typeRows = actions.rows.type.map((x) => ({ ...x, _key: `${get(x, "dimensions.type") ?? "?"} · ${get(x, "dimensions.decision") ?? "?"}` }));
	return section("zt-isolation", "Devices & networks", "Browser Isolation", "browserIsolationSessionsAdaptiveGroups, browserIsolationUserActionsAdaptiveGroups", [
		m("Isolated sessions", total(sessions.rows.tot, "count")),
		m("User actions matched", total(actions.rows.type, "count")),
	], [
		table("User actions (type · decision)", typeRows, "_key", "Action", [["count", "Count"]]),
	], [...sessions.errors, ...actions.errors]);
}

async function discovery(api: Api, range: DateRange): Promise<Section> {
	const ds = "zeroTrustPrivateNetworkDiscoveryGroups";
	const by = (dim: string): AliasQuery => ({ selection: `{ count uniq { origins } dimensions { ${dim} } }`, orderBy: "count_DESC", limit: 200 });
	const res = await accountAliases(api, ds, {
		tot: { selection: "{ count uniq { origins emails userIds } }", limit: 1 },
		status: by("status"), transport: by("transport"), host: by("hostname"),
	}, range, { maxDays: 31, byDate: true });
	const r = res.rows;
	return section("zt-discovery", "Devices & networks", "Private network discovery", ds, [
		m("Origins discovered", maxOf(r.tot, "uniq.origins")),
		m("Users", maxOf(r.tot, "uniq.userIds")),
		m("Records", total(r.tot, "count")),
	], [
		table("By status", r.status, "dimensions.status", "Status", [["count", "Records"], ["uniq.origins", "Origins", "max"]]),
		table("By transport", r.transport, "dimensions.transport", "Transport", [["count", "Records"]]),
		table("Top hostnames", r.host, "dimensions.hostname", "Hostname", [["count", "Records"]]),
	], res.errors);
}

// ---------------------------------------------------------------------------
// Everything else: sampled / performance datasets, one row each

async function otherDatasets(api: Api, range: DateRange): Promise<Section> {
	// [dataset, label, selection, value, filters by date instead of datetime]
	const list: [string, string, string, (r: Row[]) => string | number | null, boolean?][] = [
		["gatewayL7RequestsAdaptiveGroups", "Gateway HTTP requests (sampled detail)", "{ count }", (r) => total(r, "count")],
		["gatewayResolverQueriesAdaptiveGroups", "Gateway DNS queries (sampled detail)", "{ count }", (r) => total(r, "count")],
		["gatewayL4SessionsAdaptiveGroups", "Gateway L4 sessions (sampled)", "{ count }", (r) => total(r, "count")],
		["gatewayL4DownstreamSessionsAdaptiveGroups", "Client → edge sessions", "{ count sum { bytesSent bytesRecvd } }", (r) => total(r, "count")],
		["gatewayL4UpstreamSessionsAdaptiveGroups", "Edge → origin sessions", "{ count sum { bytesSent bytesRecvd } }", (r) => total(r, "count")],
		["gatewayResolverByCustomResolverGroups", "Custom DNS resolver queries", "{ count avg { customResolverTimeInMs } }", (r) => total(r, "count")],
		["gatewayResolverByRuleExecutionPerformanceAdaptiveGroups", "DNS policy evaluations", "{ count max { executionTime } }", (r) => total(r, "count")],
		["accessLoginRequestsAdaptiveGroups", "Access login requests (sampled)", "{ count }", (r) => total(r, "count")],
		["privacyProxyRequestMetricsAdaptiveGroups", "Privacy Proxy requests", "{ count }", (r) => total(r, "count"), true],
		["privacyProxyIngressConnMetricsAdaptiveGroups", "Privacy Proxy client connections", "{ count }", (r) => total(r, "count"), true],
		["sinkholeRequestLogsAdaptiveGroups", "Sinkholed requests", "{ count }", (r) => total(r, "count")],
	];
	const results = await Promise.all(
		list.map(([ds, , sel, , byDate]) => accountAliases(api, ds, { tot: { selection: sel, limit: 1 } }, range, { ...ADAPTIVE, byDate })),
	);
	const rows = list.map(([ds, label, , pick], i) => {
		const { rows: r, errors } = results[i];
		const partial = errors.find((e) => e.startsWith("Partial:"));
		const failed = errors.find((e) => !e.startsWith("Partial:"));
		const value = failed && !r.tot.length ? null : pick(r.tot);
		const since = partial ? / from (\d{4}-\d{2}-\d{2})/.exec(partial)?.[1] : undefined;
		const status = failed ? shortError(failed) : (value as number) > 0 ? "Has data" : "No data";
		return { dataset: label, name: ds, records: value, status: since ? `${status} (kept from ${since})` : status };
	});
	return section("zt-other", "Other datasets", "Other Zero Trust datasets", "sampled / performance datasets", [
		m("Datasets with data", rows.filter((r) => (r.records as number) > 0).length),
	], [
		{
			title: "Datasets",
			columns: [
				{ key: "dataset", label: "What it measures" },
				{ key: "name", label: "GraphQL dataset" },
				{ key: "records", label: "Records (sampled)", unit: "count" },
				{ key: "status", label: "Status" },
			],
			rows,
		},
	], [], ["Sampled datasets keep ~31 days or less; older ranges show only the part still available."]);
}

// ---------------------------------------------------------------------------
// Helpers

/** [value path, column label, how to combine windows ("sum" | "max"), unit] */
type Spec = [string, string, ("sum" | "max")?, Unit?];

function table(title: string, rows: Row[], keyPath: string, keyLabel: string, specs: Spec[], keyFormat?: (k: string) => string): Table {
	const agg = new Map<string, Record<string, number>>();
	for (const r of rows) {
		const raw = get(r, keyPath);
		const k = raw === null || raw === undefined || raw === "" ? "(none)" : String(raw);
		const acc = agg.get(k) ?? {};
		specs.forEach(([path, , how = "sum"], i) => {
			const v = num(get(r, path));
			acc[`c${i}`] = how === "max" ? Math.max(acc[`c${i}`] ?? 0, v) : (acc[`c${i}`] ?? 0) + v;
		});
		agg.set(k, acc);
	}
	const sorted = [...agg.entries()].sort((a, b) => (b[1].c0 ?? 0) - (a[1].c0 ?? 0)).slice(0, TOP);
	const columns: Column[] = [{ key: "k", label: keyLabel }, ...specs.map(([, label, , unit], i) => ({ key: `c${i}`, label, unit: unit ?? ("count" as Unit) }))];
	return { title, columns, rows: sorted.map(([k, v]) => ({ k: keyFormat ? keyFormat(k) : k, ...v })) };
}

function section(id: string, group: string, title: string, source: string, metrics: Metric[], tables: Table[], errors: string[], notes: string[] = []): Section {
	// "Partial" = older days are past retention: informational, not a failure.
	const partial = [...new Set(errors.filter((e) => e.startsWith("Partial:")).map((e) => e.replace(/^Partial: /, "")))];
	const failures = errors.filter((e) => !e.startsWith("Partial:"));
	const empty = metrics.every((x) => !x.value) && tables.every((t) => t.rows.length === 0) && failures.length === 0;
	return {
		id,
		group: `Zero Trust · ${group}`,
		title,
		source,
		metrics,
		tables: tables.filter((t) => t.rows.length > 0),
		notes: [...(empty ? ["No activity in this date range."] : []), ...partial, ...notes],
		errors: failures,
	};
}

function m(label: string, value: number | null, unit: Unit = "count", hint?: string): Metric {
	return hint ? { label, value, unit, hint } : { label, value, unit };
}

function multiWindow(range: DateRange, maxDays: number): string | undefined {
	return splitRange(range, maxDays).length > 1 ? `Highest ${maxDays}-day count; ranges longer than ${maxDays} days can't be de-duplicated` : undefined;
}

function resolverDecision(k: string): string {
	// Documented codes: https://developers.cloudflare.com/cloudflare-one/insights/logs/dashboard-logs/gateway-logs/#resolver-decisions
	const names: Record<string, string> = {
		"3": "Blocked by category", "4": "Allowed – no Gateway location", "5": "Allowed – no policy match",
		"6": "Blocked – always-blocked category", "7": "Overridden – Safe Search", "8": "Overridden – Override policy",
		"9": "Blocked – IP in response matched Block policy", "10": "Allowed – IP in response matched Allow policy",
	};
	return names[k] ? `${names[k]} (${k})` : k;
}

function shortError(e: string): string {
	return e.replace(/^\d{4}-\d{2}-\d{2} → \d{4}-\d{2}-\d{2}: /, "").slice(0, 120);
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

function total(rows: Row[], path: string): number {
	return rows.reduce((a, r) => a + num(get(r, path)), 0);
}

function maxOf(rows: Row[], path: string): number {
	return rows.reduce((a, r) => Math.max(a, num(get(r, path))), 0);
}

function sumWhere(rows: Row[], keyPath: string, test: (v: unknown) => boolean, valuePath: string): number {
	return rows.filter((r) => test(get(r, keyPath))).reduce((a, r) => a + num(get(r, valuePath)), 0);
}

function weightedAvg(rows: Row[], avgPath: string, weightPath: string): number | null {
	const w = total(rows, weightPath);
	if (!w) return null;
	return rows.reduce((a, r) => a + num(get(r, avgPath)) * num(get(r, weightPath)), 0) / w;
}
