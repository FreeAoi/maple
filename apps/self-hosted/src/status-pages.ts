const unavailable = () =>
	Effect.fail(
		new StatusPageStoreError({
			message: "Public status page storage is not configured for this deployment",
			operation: "unavailable",
			key: "",
			cause: undefined,
		}),
	)

export const unavailableStatusPageStore = Layer.succeed(StatusPageStore, {
	putSnapshot: unavailable,
	putRoutes: unavailable,
	readSlugRoute: unavailable,
	deleteRoutes: unavailable,
	deletePage: unavailable,
	putHeartbeat: unavailable,
	listKeys: unavailable,
	readOverlayEntry: unavailable,
	deleteOverlayEntry: unavailable,
})

import { Effect, Layer } from "effect"
import { StatusPageStore, StatusPageStoreError } from "@maple/backend/services/status-pages/StatusPageStore"
