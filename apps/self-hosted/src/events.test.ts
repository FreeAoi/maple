import { expect, it, vi } from "vitest"
import { eventsHandler, insertQueries } from "./events"

it("converts a shared log timestamp into its two different destination types", () => {
	const query = insertQueries("default").get("logs")
	expect(query).toContain("timestamp AS Timestamp, CAST(timestamp, 'DateTime') AS TimestampTime")
})

const config = {
	url: "http://clickhouse:8123",
	database: "maple",
	user: "writer",
	password: "secret",
	readUser: "reader",
	readPassword: "read-secret",
	token: "internal",
	orgId: "default",
}
const request = (name: string, authorized = true) =>
	new Request(`http://maple/v0/events?name=${encodeURIComponent(name)}`, {
		method: "POST",
		headers: authorized ? { authorization: "Bearer internal" } : {},
		body: '{"session_id":"s1","chunk_seq":1}',
	})

it("runs internal discovery SQL with the read-only account", async () => {
	const send = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"data":[{"orgId":"default"}]}'))
	const response = await eventsHandler(
		config,
		send,
	)(
		new Request("http://maple/v0/sql", {
			method: "POST",
			headers: { authorization: "Bearer internal" },
			body: "SELECT OrgId FROM traces FORMAT JSON",
		}),
	)
	expect(await response.json()).toEqual({ data: [{ orgId: "default" }] })
	const headers = new Headers(send.mock.calls[0]?.[1]?.headers)
	expect(headers.get("X-ClickHouse-User")).toBe("reader")
	expect(headers.get("X-ClickHouse-Key")).toBe("read-secret")
})

it("rejects missing credentials and unknown tables before reaching ClickHouse", async () => {
	const send = vi.fn<typeof fetch>()
	const handle = eventsHandler(config, send)
	expect((await handle(request("session_replay_events", false))).status).toBe(401)
	expect((await handle(request("traces; DROP TABLE logs"))).status).toBe(400)
	expect(send).not.toHaveBeenCalled()
})

it("projects replay rows, pins the tenant and preserves failed insert responses for retry", async () => {
	const send = vi
		.fn<typeof fetch>()
		.mockResolvedValueOnce(new Response("", { status: 200 }))
		.mockResolvedValueOnce(new Response("failed", { status: 500 }))
		.mockResolvedValueOnce(new Response("Code: 27. Late insert failure", { status: 200 }))
	const handle = eventsHandler(config, send)
	expect((await handle(request("session_replay_events"))).status).toBe(200)
	const [target, options] = send.mock.calls[0]!
	const query = new URL(String(target)).searchParams.get("query")!
	expect(query).toContain("INSERT INTO session_replay_events")
	expect(query).toContain("SELECT 'default' AS OrgId, session_id AS SessionId, chunk_seq AS ChunkSeq")
	expect(new URL(String(target)).searchParams.get("wait_end_of_query")).toBe("1")
	expect(options).toMatchObject({ redirect: "error" })
	expect(new Headers(options?.headers).get("X-ClickHouse-User")).toBe("writer")
	expect((await handle(request("session_replay_events"))).status).toBe(502)
	expect((await handle(request("session_replay_events"))).status).toBe(502)
})
