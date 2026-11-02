it("disables status page tools and routes while preserving the other self-hosted flags", async () => {
	const flags = await Effect.runPromise(
		OrganizationFeatureFlagsService.use((service) => service.flags(OrgId.make("default"))).pipe(
			Effect.provide(
				OrganizationFeatureFlagsService.layer.pipe(
					Layer.provide(Env.layer),
					Layer.provide(
						ConfigProvider.layer(
							ConfigProvider.fromUnknown({
								MAPLE_AUTH_MODE: "self_hosted",
								MAPLE_STATUS_PAGES_DISABLED: "1",
								MAPLE_ROOT_PASSWORD: "test-password",
								TINYBIRD_TOKEN: "test-token",
								TINYBIRD_HOST: "https://api.tinybird.co",
								MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
								MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "test-lookup-secret",
							}),
						),
					),
				),
			),
		),
	)
	expect(flags).toEqual({ ...ENABLED_ORGANIZATION_FEATURE_FLAGS, statusPages: false })
})

it("fails explicitly if a caller tries to publish without configured storage", async () => {
	const result = await Effect.runPromise(
		StatusPageStore.use((store) =>
			store.putSnapshot(StatusPageId.make("00000000-0000-4000-8000-000000000001"), "{}"),
		).pipe(Effect.provide(unavailableStatusPageStore), Effect.result),
	)
	expect(result).toMatchObject({
		_tag: "Failure",
		failure: {
			_tag: "@maple/backend/status-pages/StatusPageStoreError",
			message: "Public status page storage is not configured for this deployment",
		},
	})
})

import { ConfigProvider, Effect, Layer } from "effect"
import { expect, it } from "vitest"
import { OrgId, StatusPageId } from "@maple/domain/primitives"
import { ENABLED_ORGANIZATION_FEATURE_FLAGS } from "@maple/domain/organization-feature-flags"
import { Env } from "@maple/backend/platform/Env"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { StatusPageStore } from "@maple/backend/services/status-pages/StatusPageStore"
import { unavailableStatusPageStore } from "./status-pages"
