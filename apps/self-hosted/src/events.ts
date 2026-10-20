export function insertQueries(orgId: string) {
	const queries = new Map<string, string>()
	const org = `'${orgId.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
	for (const ds of Effect.runSync(buildTinybirdProjectManifest).datasources) {
		if (!WRITABLE_TABLES.has(ds.name)) continue
		const columns: string[] = []
		const selects: string[] = []
		const fields = new Map<string, string>()
		for (const field of emitJsonPathSpec(ds)) {
			if (field.column === "OrgId") {
				columns.push(field.column)
				selects.push(`${org} AS OrgId`)
				continue
			}
			if (
				field.jsonPath === null ||
				(field.hasDefaultExpression &&
					(field.jsonPath === `$.${field.column}` || field.jsonPath === `$.${field.column}[:]`))
			)
				continue
			const leaf = /^\$\.([A-Za-z_][A-Za-z0-9_]*)(\[:\])?$/.exec(field.jsonPath)?.[1]
			if (!leaf)
				throw new EventsConfigurationError({
					message: `Unsupported JSON path for ${ds.name}.${field.column}`,
				})
			columns.push(field.column)
			const expression =
				fields.has(leaf) && fields.get(leaf) !== field.type
					? `CAST(${leaf}, '${field.type.replace(/'/g, "\\'")}')`
					: leaf
			selects.push(`${expression} AS ${field.column}`)
			if (!fields.has(leaf)) fields.set(leaf, field.type)
		}
		const structure = [...fields]
			.map(([name, type]) => `${name} ${type}`)
			.join(", ")
			.replace(/'/g, "\\'")
		queries.set(
			ds.name,
			`INSERT INTO ${ds.name} (${columns.join(", ")}) SELECT ${selects.join(", ")} FROM input('${structure}') FORMAT JSONEachRow`,
		)
	}
	return queries
}

export function eventsHandler(
	config: {
		url: string
		database: string
		user: string
		password: string
		readUser: string
		readPassword: string
		token: string
		orgId: string
	},
	send: typeof fetch = fetch,
) {
	const queries = insertQueries(config.orgId)
	return async (request: Request): Promise<Response> => {
		const supplied = Buffer.from(request.headers.get("authorization") ?? "")
		const expected = Buffer.from(`Bearer ${config.token}`)
		if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
			return Response.json({ error: "Unauthorized" }, { status: 401 })
		}
		const url = new URL(request.url)
		const read = url.pathname === "/v0/sql"
		const query = queries.get(url.searchParams.get("name") ?? "")
		if (request.method !== "POST" || (!read && (url.pathname !== "/v0/events" || !query))) {
			return Response.json({ error: "Unknown datasource" }, { status: 400 })
		}
		const upstream = new URL(config.url)
		upstream.searchParams.set("database", config.database)
		if (!read && query) upstream.searchParams.set("query", query)
		upstream.searchParams.set("date_time_input_format", "best_effort")
		upstream.searchParams.set("input_format_skip_unknown_fields", "1")
		upstream.searchParams.set("input_format_defaults_for_omitted_fields", "1")
		// ClickHouse must finish before sending 200; otherwise a late error would lose a WAL batch.
		upstream.searchParams.set("wait_end_of_query", "1")
		try {
			const headers = new Headers({
				"X-ClickHouse-User": read ? config.readUser : config.user,
				"X-ClickHouse-Key": read ? config.readPassword : config.password,
			})
			const encoding = request.headers.get("content-encoding")
			if (encoding) headers.set("content-encoding", encoding)
			const options = {
				method: "POST",
				body: request.body,
				duplex: "half",
				headers,
				redirect: "error" as const,
				signal: AbortSignal.timeout(30_000),
			}
			const response = await send(upstream, options)
			if (read)
				return new Response(response.body, {
					status: response.status,
					headers: { "content-type": "application/json" },
				})
			if (!response.ok) {
				await response.body?.cancel()
				return Response.json({ error: "ClickHouse rejected the insert" }, { status: 502 })
			}
			if ((await response.text()).trim() !== "") {
				return Response.json({ error: "ClickHouse insert did not complete" }, { status: 502 })
			}
			return Response.json({ quarantined_rows: 0 })
		} catch {
			return Response.json({ error: "ClickHouse insert unavailable" }, { status: 503 })
		}
	}
}

import { timingSafeEqual } from "node:crypto"
import { Effect, Schema } from "effect"
import { emitJsonPathSpec } from "@maple/domain/clickhouse"
import { buildTinybirdProjectManifest } from "../../../packages/domain/src/tinybird/project-manifest"

class EventsConfigurationError extends Schema.TaggedError<EventsConfigurationError>()(
	"@maple/self-hosted/EventsConfigurationError",
	{ message: Schema.String },
) {}
const WRITABLE_TABLES = new Set([
	"traces",
	"logs",
	"metrics_sum",
	"metrics_gauge",
	"metrics_histogram",
	"metrics_exponential_histogram",
	"session_replays",
	"session_replay_events",
	"session_events",
	"product_events",
	"audit_log",
	"alert_checks",
	"service_map_edges_hourly_ingest",
	"service_address_resolutions_hourly",
])
