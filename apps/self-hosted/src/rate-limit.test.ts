import { Effect } from "effect"
import { expect, it } from "vitest"
import { rateLimiter } from "./rate-limit"

it("limits each credential and resets its budget in the next window", () => {
	let now = 1000
	const limiter = rateLimiter(1, 10, () => now)
	expect(Effect.runSync(limiter.limit("one")).success).toBe(true)
	expect(Effect.runSync(limiter.limit("one")).success).toBe(false)
	expect(Effect.runSync(limiter.limit("two")).success).toBe(true)
	now = 11_000
	expect(Effect.runSync(limiter.limit("one")).success).toBe(true)
})
