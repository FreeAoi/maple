export function openSessions(directory: string, env: Record<string, unknown>) {
	mkdirSync(directory, { recursive: true, mode: 0o700 })
	const sessions = new Map<string, { session: ChatSession; db: DatabaseSync }>()
	const timers = new Map<string, ReturnType<typeof setTimeout>>()
	const pending = new Set<Promise<unknown>>()
	const namespace: ChatSessionNamespace = {
		jurisdiction: () => namespace,
		getByName: (name) => {
			let entry = sessions.get(name)
			if (!entry) {
				const path = join(directory, `${createHash("sha256").update(name).digest("hex")}.sqlite`)
				const db = new DatabaseSync(path)
				db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;")
				const sql: ChatSessionSql = {
					exec: <T extends Record<string, SqlStorageValue>>(
						query: string,
						...values: SqlStorageValue[]
					) => {
						const rows = db
							.prepare(query)
							.all(
								...values.map((value) =>
									value instanceof ArrayBuffer ? new Uint8Array(value) : value,
								),
							) as T[]
						return {
							toArray: () => rows,
							one: () => {
								if (rows.length !== 1)
									throw new SessionStorageError({ message: "Expected one session row" })
								return rows[0]!
							},
						}
					},
				}
				addMissingSessionColumns(sql)
				db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)")
				for (const file of readdirSync(migrations)
					.filter((file) => file.endsWith(".sql"))
					.sort()) {
					if (db.prepare("SELECT name FROM schema_migrations WHERE name = ?").get(file)) continue
					db.exec("BEGIN IMMEDIATE")
					try {
						db.exec(readFileSync(join(migrations, file), "utf8"))
						db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(file)
						db.exec("COMMIT")
					} catch (cause) {
						db.exec("ROLLBACK")
						db.close()
						throw cause
					}
				}
				const session = new ChatSession(
					{
						storage: {
							sql,
							setAlarm: async (at) => {
								clearTimeout(timers.get(name))
								timers.set(
									name,
									setTimeout(() => session.alarm(), Math.max(0, at - Date.now())),
								)
							},
						},
						waitUntil: (task) => {
							pending.add(task)
							void task
								.catch((cause) =>
									Effect.runSync(Effect.logError("Session task failed", cause)),
								)
								.finally(() => pending.delete(task))
						},
					},
					env,
					(input) => applyChatProposal({ ...input, chatSessions: namespace }),
					(input) => runChatSessionTurn({ ...input, chatSessions: namespace }),
				)
				entry = { session, db }
				sessions.set(name, entry)
				session.alarm()
			}
			return chatSessionRpc(entry.session)
		},
	}
	// Alarms do not survive a process exit; restore the existing turn recovery on boot.
	for (const file of readdirSync(directory).filter((file) => /^[a-f0-9]{64}\.sqlite$/.test(file))) {
		const db = new DatabaseSync(join(directory, file))
		const row = db
			.prepare(
				"SELECT json_extract(running_input, '$.sessionId') AS name FROM session WHERE running = 1",
			)
			.get()
		db.close()
		if (typeof row?.name === "string") namespace.getByName(row.name)
	}
	return {
		namespace,
		close: async () => {
			for (const { session } of sessions.values()) session.abort("evicted")
			await Promise.allSettled(pending)
			for (const timer of timers.values()) clearTimeout(timer)
			for (const { db } of sessions.values()) db.close()
			sessions.clear()
		},
	}
}

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { Effect, Schema } from "effect"
import type { ChatSessionNamespace } from "@maple/backend/platform/chat-sessions"
import {
	addMissingSessionColumns,
	ChatSession,
	chatSessionRpc,
	type ChatSessionSql,
} from "../../ai/src/chat/ChatSession"
import { applyChatProposal } from "../../ai/src/chat/apply-proposal"
import { runChatSessionTurn } from "../../ai/src/chat/turn-runner"

const migrations = fileURLToPath(new URL("../../ai/migrations/chat-session", import.meta.url))
class SessionStorageError extends Schema.TaggedError<SessionStorageError>()(
	"@maple/self-hosted/SessionStorageError",
	{ message: Schema.String },
) {}
