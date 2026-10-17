/** Thin clients for the Cloudflare GraphQL Analytics API and the REST API. */

const API = "https://api.cloudflare.com/client/v4";

export interface Api {
	token: string;
	accountId: string;
}

export interface DateRange {
	from: string; // YYYY-MM-DD, inclusive
	to: string; // YYYY-MM-DD, inclusive
}

export interface Zone {
	id: string;
	name: string;
	plan: string;
	enterprise: boolean;
}

/** A dataset row: whatever the selection asked for (sum/max/avg/count/dimensions). */
export type Row = Record<string, unknown>;

export interface RowsResult {
	rows: Row[];
	errors: string[];
}

export class ApiError extends Error {
	/** True when the fix is a configuration change (shown to the user as-is). */
	constructor(message: string, readonly setup = false) {
		super(message);
	}
}

export interface QueryOpts {
	maxDays?: number;
	extraFilter?: string;
	limit?: number;
	orderBy?: string;
}

// ---------------------------------------------------------------------------
// GraphQL

interface GqlResponse<T> {
	data: T | null;
	errors?: { message: string }[] | null;
}

export async function gql<T>(api: Api, query: string, variables: Record<string, unknown>): Promise<T> {
	const res = await fetch(`${API}/graphql`, {
		method: "POST",
		headers: { Authorization: `Bearer ${api.token}`, "Content-Type": "application/json" },
		body: JSON.stringify({ query, variables }),
	});
	if (!res.ok) throw new ApiError(`GraphQL HTTP ${res.status}`);
	const body = (await res.json()) as GqlResponse<T>;
	if (body.errors?.length) throw new ApiError(body.errors.map((e) => e.message).join("; "));
	if (!body.data) throw new ApiError("GraphQL returned no data");
	return body.data;
}

/**
 * Most adaptive datasets reject ranges wider than ~32 days, so long ranges are
 * split into windows of at most `maxDays` and the rows from every window are
 * returned together. A window that fails (usually "older than the retention
 * period") is reported in `errors` and skipped, so the rest still shows.
 */
export async function accountRows(
	api: Api,
	dataset: string,
	selection: string,
	range: DateRange,
	opts: QueryOpts = {},
): Promise<RowsResult> {
	const query = `query($a: String!, $s: Date!, $u: Date!) {
		viewer { accounts(filter: { accountTag: $a }) {
			rows: ${dataset}(limit: ${opts.limit ?? 10000}${opts.orderBy ? `, orderBy: [${opts.orderBy}]` : ""}, filter: { date_geq: $s, date_leq: $u${opts.extraFilter ? `, ${opts.extraFilter}` : ""} }) ${selection}
		} }
	}`;
	return runWindows(range, opts.maxDays ?? 31, async (w) => {
		const data = await gql<{ viewer: { accounts: { rows: Row[] }[] } }>(api, query, { a: api.accountId, s: w.from, u: w.to });
		return data.viewer.accounts[0]?.rows ?? [];
	});
}

/**
 * Same as accountRows, for datasets filtered by `datetime` (a Time) instead of `date`
 * — the Zero Trust `cf1…` rollups and most adaptive datasets. Each window covers whole
 * UTC days: [from 00:00, day after `to` 00:00), capped at "now".
 */
export async function accountRowsByTime(
	api: Api,
	dataset: string,
	selection: string,
	range: DateRange,
	opts: QueryOpts = {},
): Promise<RowsResult> {
	const query = `query($a: String!, $s: Time!, $u: Time!) {
		viewer { accounts(filter: { accountTag: $a }) {
			rows: ${dataset}(limit: ${opts.limit ?? 10000}${opts.orderBy ? `, orderBy: [${opts.orderBy}]` : ""}, filter: { datetime_geq: $s, datetime_lt: $u${opts.extraFilter ? `, ${opts.extraFilter}` : ""} }) ${selection}
		} }
	}`;
	return runWindows(range, opts.maxDays ?? 31, async (w) => {
		const end = Math.min(Date.parse(`${w.to}T00:00:00Z`) + 86_400_000, Date.now());
		const data = await gql<{ viewer: { accounts: { rows: Row[] }[] } }>(api, query, {
			a: api.accountId,
			s: `${w.from}T00:00:00Z`,
			u: new Date(end).toISOString().replace(/\.\d{3}Z$/, "Z"),
		});
		return data.viewer.accounts[0]?.rows ?? [];
	});
}

export interface AliasQuery {
	selection: string;
	limit?: number;
	orderBy?: string;
	extraFilter?: string;
}

/**
 * Several views of one account dataset in a single GraphQL request (one alias per view),
 * split into windows like accountRows. Returns rows per alias.
 */
export async function accountAliases(
	api: Api,
	dataset: string,
	aliases: Record<string, AliasQuery>,
	range: DateRange,
	opts: { maxDays?: number; byDate?: boolean } = {},
): Promise<{ rows: Record<string, Row[]>; errors: string[] }> {
	const byDate = opts.byDate ?? false;
	const vars = byDate ? "$s: Date!, $u: Date!" : "$s: Time!, $u: Time!";
	const timeFilter = byDate ? "date_geq: $s, date_leq: $u" : "datetime_geq: $s, datetime_lt: $u";
	const parts = Object.entries(aliases).map(
		([alias, q]) =>
			`${alias}: ${dataset}(limit: ${q.limit ?? 1000}${q.orderBy ? `, orderBy: [${q.orderBy}]` : ""}, filter: { ${timeFilter}${q.extraFilter ? `, ${q.extraFilter}` : ""} }) ${q.selection}`,
	);
	const query = `query($a: String!, ${vars}) { viewer { accounts(filter: { accountTag: $a }) { ${parts.join("\n")} } } }`;

	const result = await runWindows(range, opts.maxDays ?? 31, async (w) => {
		const end = Math.min(Date.parse(`${w.to}T00:00:00Z`) + 86_400_000, Date.now());
		const variables = byDate
			? { a: api.accountId, s: w.from, u: w.to }
			: { a: api.accountId, s: `${w.from}T00:00:00Z`, u: new Date(end).toISOString().replace(/\.\d{3}Z$/, "Z") };
		const data = await gql<{ viewer: { accounts: Record<string, Row[]>[] } }>(api, query, variables);
		const acct = data.viewer.accounts[0] ?? {};
		// Tag each row with its alias so runWindows can merge windows; split again below.
		return Object.keys(aliases).flatMap((alias) => (acct[alias] ?? []).map((r) => ({ ...r, __alias: alias })));
	});

	const rows: Record<string, Row[]> = Object.fromEntries(Object.keys(aliases).map((a) => [a, [] as Row[]]));
	for (const r of result.rows) {
		const { __alias, ...rest } = r as Row & { __alias: string };
		rows[__alias].push(rest);
	}
	return { rows, errors: result.errors };
}

export async function zoneRows(
	api: Api,
	zoneId: string,
	dataset: string,
	selection: string,
	range: DateRange,
	opts: QueryOpts = {},
): Promise<RowsResult> {
	const query = `query($z: String!, $s: Date!, $u: Date!) {
		viewer { zones(filter: { zoneTag: $z }) {
			rows: ${dataset}(limit: ${opts.limit ?? 10000}${opts.orderBy ? `, orderBy: [${opts.orderBy}]` : ""}, filter: { date_geq: $s, date_leq: $u${opts.extraFilter ? `, ${opts.extraFilter}` : ""} }) ${selection}
		} }
	}`;
	return runWindows(range, opts.maxDays ?? 31, async (w) => {
		const data = await gql<{ viewer: { zones: { rows: Row[] }[] } }>(api, query, { z: zoneId, s: w.from, u: w.to });
		return data.viewer.zones[0]?.rows ?? [];
	});
}

async function runWindows(range: DateRange, maxDays: number, fn: (w: DateRange) => Promise<Row[]>): Promise<RowsResult> {
	const rows: Row[] = [];
	const errors: string[] = [];

	const run = async (w: DateRange, depth: number): Promise<void> => {
		try {
			rows.push(...(await fn(w)));
		} catch (err) {
			// Range wider than this dataset allows (e.g. "wider than 1w"), or a query that would
			// read too much data: split smaller and retry.
			const tooMuch = /read too much data/i.test(err instanceof Error ? err.message : String(err));
			const days = splitRange(w, 1).length;
			const allowed = maxRangeDays(err) ?? (tooMuch && days > 1 ? Math.ceil(days / 2) : null);
			if (allowed && depth < 3 && splitRange(w, allowed).length > 1) {
				await Promise.all(splitRange(w, allowed).map((sub) => run(sub, depth + 1)));
				return;
			}
			// Window starts before the dataset's retention: retry with what is still kept.
			const earliest = retentionStart(err);
			if (earliest && earliest > w.from && earliest <= w.to && depth < 3) {
				errors.push(`Partial: Cloudflare only keeps this data from ${earliest}, so ${w.from} → ${prevDay(earliest)} is missing.`);
				await run({ from: earliest, to: w.to }, depth + 1);
				return;
			}
			// Entirely before retention: covered by the "Partial" note of the window that crosses it.
			if (earliest && earliest > w.to) {
				errors.push(`Partial: Cloudflare only keeps this data from ${earliest}, so ${w.from} → ${w.to} is missing.`);
				return;
			}
			errors.push(`${w.from} → ${w.to}: ${cleanError(err)}`);
		}
	};

	await Promise.all(splitRange(range, maxDays).map((w) => run(w, 0)));
	return { rows, errors: mergePartial(errors) };
}

/** From "cannot request a time range wider than 1w", the allowed window in whole days. */
function maxRangeDays(err: unknown): number | null {
	const m = /wider than ((?:\d+w)?(?:\d+d)?(?:\d+h)?)/.exec(err instanceof Error ? err.message : String(err));
	if (!m || !m[1]) return null;
	const part = (u: string) => Number(new RegExp(`(\\d+)${u}`).exec(m[1])?.[1] ?? 0);
	const days = Math.floor(part("w") * 7 + part("d") + part("h") / 24);
	return days >= 1 ? days : null;
}

/** Several windows can each report missing days; show one combined note. */
function mergePartial(errors: string[]): string[] {
	const partial = errors.filter((e) => e.startsWith("Partial:"));
	if (partial.length <= 1) return errors;
	const keeps = partial.map((e) => /keeps this data from (\d{4}-\d{2}-\d{2})/.exec(e)?.[1] ?? "").sort();
	const firstMissing = partial.map((e) => /so (\d{4}-\d{2}-\d{2}) →/.exec(e)?.[1] ?? "").sort()[0];
	const earliest = keeps[keeps.length - 1];
	return [
		`Partial: Cloudflare only keeps this data from ${earliest}, so ${firstMissing} → ${prevDay(earliest)} is missing.`,
		...errors.filter((e) => !e.startsWith("Partial:")),
	];
}

/** From "cannot request data older than 4w4d", the first full UTC day still queryable. */
function retentionStart(err: unknown): string | null {
	const m = /older than ((?:\d+w)?(?:\d+d)?(?:\d+h)?)/.exec(err instanceof Error ? err.message : String(err));
	if (!m || !m[1]) return null;
	const part = (u: string) => Number(new RegExp(`(\\d+)${u}`).exec(m[1])?.[1] ?? 0);
	const ms = ((part("w") * 7 + part("d")) * 24 + part("h")) * 3_600_000;
	if (!ms) return null;
	// Next midnight after the cutoff, so the whole first day is inside retention.
	const cutoff = Date.now() - ms;
	return isoDate(Math.ceil(cutoff / 86_400_000) * 86_400_000);
}

function prevDay(date: string): string {
	return isoDate(Date.parse(`${date}T00:00:00Z`) - 86_400_000);
}

export function splitRange(range: DateRange, maxDays: number): DateRange[] {
	const out: DateRange[] = [];
	let start = Date.parse(`${range.from}T00:00:00Z`);
	const end = Date.parse(`${range.to}T00:00:00Z`);
	while (start <= end) {
		const stop = Math.min(start + (maxDays - 1) * 86_400_000, end);
		out.push({ from: isoDate(start), to: isoDate(stop) });
		start = stop + 86_400_000;
	}
	return out;
}

function isoDate(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

function cleanError(err: unknown): string {
	const msg = err instanceof Error ? err.message : String(err);
	// Drop the account/zone id from Cloudflare's quota messages; keep the reason.
	return msg.replace(/^(account|zone) "[0-9a-f]+" /, "");
}

// ---------------------------------------------------------------------------
// REST

interface RestResponse<T> {
	success: boolean;
	result: T;
	result_info?: { page?: number; per_page?: number; total_pages?: number; count?: number; total_count?: number };
	errors?: { code: number; message: string }[];
}

export async function rest<T>(api: Api, path: string): Promise<RestResponse<T>> {
	const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${api.token}` } });
	const body = (await res.json().catch(() => null)) as RestResponse<T> | null;
	if (!res.ok || !body?.success) {
		const detail = body?.errors?.map((e) => e.message).join("; ") || res.statusText;
		const hint = res.status === 403 ? " (token is missing a permission)" : "";
		throw new ApiError(`HTTP ${res.status}${hint}: ${detail}`);
	}
	return body;
}

/**
 * Paging stops on the last page. Not every endpoint returns total_pages (Spectrum apps
 * doesn't), so a short page also ends it, and a hard limit guards against loops.
 */
export function isLastPage(body: RestResponse<unknown>, page: number, perPage: number): boolean {
	const info = body.result_info;
	const received = Array.isArray(body.result) ? body.result.length : 0;
	if (!info || received < perPage || page >= 20) return true;
	if (typeof info.total_pages === "number") return page >= info.total_pages;
	if (typeof info.total_count === "number") return page * perPage >= info.total_count;
	return false;
}

// Per-isolate memo: the account a token belongs to doesn't change between requests.
const accountByToken = new Map<string, Promise<string>>();

/** The single account an API token can see. Used when ACCOUNT_ID is not configured. */
export function detectAccountId(token: string): Promise<string> {
	let pending = accountByToken.get(token);
	if (!pending) {
		pending = (async () => {
			const body = await rest<{ id: string; name: string }[]>({ token, accountId: "" }, "/accounts?per_page=50");
			if (body.result.length === 1) return body.result[0].id;
			if (body.result.length === 0) {
				throw new ApiError("The API token can't see any account. Set the ACCOUNT_ID variable in wrangler.jsonc.", true);
			}
			throw new ApiError(
				`The API token can see ${body.result.length} accounts (${body.result.map((a) => a.name).join(", ")}). Set the ACCOUNT_ID variable in wrangler.jsonc to choose one.`,
				true,
			);
		})();
		accountByToken.set(token, pending);
		void pending.catch(() => accountByToken.delete(token));
	}
	return pending;
}

export async function listZones(api: Api): Promise<Zone[]> {
	const zones: Zone[] = [];
	for (let page = 1; ; page++) {
		const body = await rest<{ id: string; name: string; plan: { name: string; legacy_id?: string } }[]>(
			api,
			`/zones?account.id=${api.accountId}&per_page=50&page=${page}`,
		);
		for (const z of body.result) {
			const plan = z.plan?.name ?? "unknown";
			zones.push({ id: z.id, name: z.name, plan, enterprise: /enterprise/i.test(plan) || z.plan?.legacy_id === "enterprise" });
		}
		if (isLastPage(body, page, 50)) break;
	}
	return zones.sort((a, b) => a.name.localeCompare(b.name));
}
