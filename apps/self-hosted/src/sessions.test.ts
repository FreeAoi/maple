import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Effect } from "effect"
import { expect, it } from "vitest"
import { openSessions } from "./sessions"

it("persists ordered transcripts across restarts and isolates session paths", async () => {
	const dir = mkdtempSync(join(tmpdir(), "maple-sessions-"))
	let store = openSessions(dir, {})
	try {
		const session = store.namespace.getByName("default:../../escape")
		await Effect.runPromise(
			session.append({ type: "user-message", id: "u1", text: "Investigate checkout" }),
		)
		await Effect.runPromise(session.append({ type: "turn-start", messageId: "a1" }))
		await Effect.runPromise(
			session.append({ type: "text-delta", messageId: "a1", text: "Found a slow query" }),
		)
		await Effect.runPromise(session.append({ type: "turn-end", messageId: "a1", reason: "stop" }))
		await store.close()
		store = openSessions(dir, {})
		const restored = store.namespace.getByName("default:../../escape")
		expect(await Effect.runPromise(restored.history())).toMatchObject([
			{ text: "Investigate checkout" },
			{ text: "Found a slow query" },
		])
		expect(await Effect.runPromise(restored.since(2))).toMatchObject([{ seq: 3 }, { seq: 4 }])
		expect(await Effect.runPromise(store.namespace.getByName("default:another").history())).toEqual([])
		expect(readdirSync(dir).filter((file) => file.endsWith(".sqlite"))).toHaveLength(2)
	} finally {
		await store.close()
		rmSync(dir, { recursive: true, force: true })
	}
})

it("releases an interrupted chat turn on boot without waiting for a client request", async () => {
	const dir = mkdtempSync(join(tmpdir(), "maple-recovery-"))
	let store = openSessions(dir, {})
	try {
		const sessionId = "default:interrupted"
		await Effect.runPromise(
			store.namespace.getByName(sessionId).append({ type: "turn-start", messageId: "a1" }),
		)
		await store.close()
		const path = join(
			dir,
			readdirSync(dir).find((file) => file.endsWith(".sqlite"))!,
		)
		const db = new DatabaseSync(path)
		db.prepare(
			"UPDATE session SET running = 1, running_since = ?, running_message_id = ?, running_input = ? WHERE id = 1",
		).run(
			Date.now(),
			"a1",
			JSON.stringify({
				sessionId,
				userMessageId: "u1",
				text: "Hello",
				tenant: { orgId: "default", userId: "root", roles: [], authMode: "self_hosted" },
				origin: { kind: "app" },
			}),
		)
		db.close()
		store = openSessions(dir, {})
		const recovered = new DatabaseSync(path)
		expect(recovered.prepare("SELECT running FROM session WHERE id = 1").get()).toMatchObject({
			running: 0,
		})
		recovered.close()
		expect(await Effect.runPromise(store.namespace.getByName(sessionId).since(1))).toMatchObject([
			{ type: "turn-end", messageId: "a1", reason: "error" },
		])
	} finally {
		await store.close()
		rmSync(dir, { recursive: true, force: true })
	}
})
