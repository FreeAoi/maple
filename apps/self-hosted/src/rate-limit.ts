export function rateLimiter(limit: number, seconds: number, now = Date.now): RateLimiter {
	let window = 0
	const counts = new Map<string, number>()
	return {
		limit: (key) =>
			Effect.sync(() => {
				const current = Math.floor(now() / (seconds * 1000))
				if (window !== current) {
					counts.clear()
					window = current
				}
				const count = counts.get(key) ?? 0
				if (count >= limit || (!counts.has(key) && counts.size >= 10_000)) return { success: false }
				counts.set(key, count + 1)
				return { success: true }
			}),
	}
}

import { Effect } from "effect"
import type { RateLimiter } from "@maple/backend/platform/bindings"
