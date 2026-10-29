const main = Effect.gen(function* () {
	const env = {
		...process.env,
		MAPLE_AUTH_MODE: "self_hosted",
		AI_WORKER: { fetch: (request: Request) => ai.handler(request) },
	}
	const publicUrl = new URL(yield* Config.String("MAPLE_API_BASE_URL"))
	const sessions = openSessions(yield* Config.String("CHAT_DATA_DIR"), env)
	yield* Effect.addFinalizer(() => Effect.promise(() => sessions.close()))
	const unavailableQueue = {
		sendBatch: () =>
			Effect.fail(
				new QueueSendError({
					message: "Cloud integration queues are not configured",
					cause: undefined,
				}),
			),
	}
	const ports = Layer.mergeAll(
		envPorts(env),
		layerMapleDbConnection(env),
		layerChatSessions(sessions.namespace, env),
		Layer.succeed(WorkersAiGateway, Option.none()),
		Layer.succeed(EmailSender, Option.none()),
		Layer.succeed(ApiV2RateLimit, rateLimiter(600, 60)),
		Layer.succeed(McpToolsRateLimit, rateLimiter(120, 10)),
		Layer.succeed(CliAuthRateLimit, rateLimiter(30, 60)),
		Layer.succeed(McpOAuthRateLimit, rateLimiter(60, 60)),
		Layer.succeed(VcsSyncQueueProducer, unavailableQueue),
		Layer.succeed(PlanetScaleWebhookQueueProducer, unavailableQueue),
		Layer.succeed(SecurityAuditWorkflowStarter, {
			create: () =>
				Effect.fail(
					new WorkflowStartError({
						message: "Cloud security audit workflows are not configured",
						cause: undefined,
					}),
				),
			cancel: () =>
				Effect.fail(
					new WorkflowCancelError({
						message: "Cloud security audit workflows are not configured",
						cause: undefined,
					}),
				),
		}),
	)
	const platform = Layer.mergeAll(DatabasePgLive, FetchHttpClient.layer, BunHttpServer.layerHttpServices)
	const sync = ElectricSyncRouter.pipe(
		Layer.provide(ElectricClient.layer),
		Layer.provide(TenantResolver.layer),
		Layer.provide(SyncConfig.layer),
	)
	const api = HttpRouter.toWebHandler(
		Layer.mergeAll(ApiRoutes, sync).pipe(
			HttpRouter.provideRequest(HttpServicesLive),
			Layer.provideMerge(ApiAuthLive.pipe(Layer.provideMerge(HttpServicesLive))),
			Layer.provideMerge(platform),
			Layer.provide(ports),
		),
		{ middleware: (effect) => withPgConnectionScope(effect).pipe(Effect.provide(ports)) },
	)
	const ai = HttpRouter.toWebHandler(
		AiRoutes.pipe(
			Layer.provideMerge(McpToolExecutorLoader.layer),
			Layer.provideMerge(AiAuthLive),
			Layer.provideMerge(layerDecisionModelFromConfig()),
			Layer.provideMerge(platform),
			HttpRouter.provideRequest(ports),
			Layer.provide(ports),
		),
		{ middleware: (effect) => withPgConnectionScope(effect).pipe(Effect.provide(ports)) },
	)
	yield* Effect.addFinalizer(() =>
		Effect.promise(async () => {
			await api.dispose()
			await ai.dispose()
		}),
	)
	const events = eventsHandler({
		url: yield* Config.String("CLICKHOUSE_URL"),
		database: yield* Config.String("CLICKHOUSE_DATABASE"),
		user: yield* Config.String("CLICKHOUSE_WRITE_USER"),
		password: yield* Config.String("CLICKHOUSE_WRITE_PASSWORD"),
		readUser: yield* Config.String("CLICKHOUSE_USER"),
		readPassword: yield* Config.String("CLICKHOUSE_PASSWORD"),
		token: yield* Config.String("TINYBIRD_TOKEN"),
		orgId: yield* Config.String("MAPLE_DEFAULT_ORG_ID"),
	})
	const server = serve({
		hostname: "0.0.0.0",
		port: yield* Config.Number("PORT").pipe(Config.withDefault(3472)),
		idleTimeout: 60,
		maxRequestBodySize: 32 * 1024 * 1024,
		fetch: (request) => {
			const headers = new Headers(request.headers)
			headers.set("x-forwarded-proto", publicUrl.protocol.slice(0, -1))
			headers.set("x-forwarded-host", publicUrl.host)
			request = new Request(request, { headers })
			const path = new URL(request.url).pathname
			if (path === "/v0/events" || path === "/v0/sql") return events(request)
			return forwardsToAi(path) ? ai.handler(request) : api.handler(request)
		},
	})
	yield* Effect.addFinalizer(() =>
		Effect.promise(async () => {
			await server.stop(true)
		}),
	)
	yield* Effect.logInfo(`Maple self-hosted listening on ${server.port}`)
	const ticks = layerTick(env, Option.none(), sessions.namespace)
	yield* Effect.all(
		ALERTING_CRONS.flatMap((cron) =>
			ALERTING_SCHEDULE[cron].lanes.map((lane) =>
				withPgConnectionScope(selectLaneProgram(cron, lane, scheduledTicks)).pipe(
					Effect.provide(ticks),
					catchTickFailure(lane),
					Effect.repeat(Schedule.cron(cron, "UTC")),
				),
			),
		),
		{ concurrency: "unbounded", discard: true },
	)
})

import { serve } from "bun"
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { Config, Effect, Layer, Option, Schedule } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/http"
import { DatabasePgLive } from "@maple/backend/platform/DatabasePgLive"
import { envPorts } from "@maple/backend/platform/env-ports"
import { layerMapleDbConnection } from "@maple/backend/platform/pg-connection-source"
import { layerChatSessions } from "@maple/backend/platform/chat-sessions"
import { withPgConnectionScope } from "@maple/backend/platform/pg-connection-scope"
import {
	ApiV2RateLimit,
	CliAuthRateLimit,
	McpOAuthRateLimit,
	McpToolsRateLimit,
	EmailSender,
	PlanetScaleWebhookQueueProducer,
	QueueSendError,
	VcsSyncQueueProducer,
	SecurityAuditWorkflowStarter,
	WorkflowStartError,
	WorkflowCancelError,
} from "@maple/backend/platform/bindings"
import { AllRoutes as ApiRoutes, ApiAuthLive } from "../../api/src/runtime/http-graph"
import { HttpServicesLive } from "../../api/src/runtime/service-graph"
import { forwardsToAi } from "../../api/src/worker/ai-forward"
import { AllRoutes as AiRoutes, AiAuthLive } from "../../ai/src/runtime/http-graph"
import { McpToolExecutorLoader } from "../../ai/src/mcp/executor-loader"
import { layerDecisionModelFromConfig } from "../../ai/src/platform/Llm"
import { WorkersAiGateway } from "../../ai/src/platform/WorkersAiHttpClient"
import { ALERTING_CRONS, ALERTING_SCHEDULE } from "../../alerting/src/schedule"
import { catchTickFailure, layerTick, scheduledTicks, selectLaneProgram } from "../../alerting/src/scheduled"
import { eventsHandler } from "./events"
import { rateLimiter } from "./rate-limit"
import { openSessions } from "./sessions"
import { ElectricSyncRouter } from "../../electric-sync/src/routes/shape.http"
import { ElectricClient } from "../../electric-sync/src/electric/ElectricClient"
import { TenantResolver } from "../../electric-sync/src/auth/TenantResolver"
import { SyncConfig } from "../../electric-sync/src/config"

BunRuntime.runMain(Effect.scoped(main))
