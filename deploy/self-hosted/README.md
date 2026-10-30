# Maple on Dokploy

This is an unofficial deployment adaptation of [Maple](https://github.com/MapleTechLabs/maple).
The upstream license and copyright notices apply.

This deployment runs the dashboard, API, MCP server, chat agents, alerting scheduler,
OTLP ingestion, uptime checks and browser replays on one Docker host. It uses PostgreSQL, ClickHouse,
SQLite chat transcripts, Electric synchronization and a persistent ingestion WAL. Cloudflare and Tinybird accounts
are not required. Model inference uses your OpenRouter key.

Use one `maple` replica. The process owns chat turns, SQLite files and cron schedules;
replicating it would run competing agents and duplicate scheduled work. This is the
single-organization `self_hosted` authentication mode with a shared root password.

## Dokploy

1. Create a **Docker Compose** service with this repository and branch as its Git source.
   Select `deploy/self-hosted/compose.yaml` as the Compose path. Use Compose, not Docker
   Stack: Stack does not build images or support the startup dependencies here.
2. Copy the variables from `.env.example` into Dokploy's Environment editor. Generate
   independent passwords and keys using the commands in that file. Set the public HTTPS
   origin and OpenRouter key. Keep the encryption/HMAC keys across redeploys.
3. Under Domains, point your hostname to **service `web`, container port `80`** and
   enable HTTPS. The API, MCP and ingestion use this same origin. No database port
   needs publishing. [Dokploy's Compose domain documentation](https://docs.dokploy.com/docs/core/docker-compose/domains).
4. Deploy. The images come prebuilt from `.github/workflows/self-hosted-images.yml` (GHCR: `maple-server`,
   `maple-web`, `maple-ingest`), so the host only pulls them; set `MAPLE_SERVER_IMAGE`, `MAPLE_WEB_IMAGE` or
   `MAPLE_INGEST_IMAGE` to pin a commit's tag. The `migrate` service applies the bundled PostgreSQL and ClickHouse migrations
   before Maple starts. It uses the CLI from this checkout, not an unpublished npm package.
5. Sign in with `MAPLE_ROOT_PASSWORD`. Create or retrieve your ingest keys from Maple's
   settings and configure your SDK with `https://your-host/ingest`. OTLP/HTTP endpoints
   are below that prefix (`/ingest/v1/traces`, `/ingest/v1/logs`, `/ingest/v1/metrics`).
   The browser SDK uses the same ingest base for replay uploads.
6. Connect your MCP client to `https://your-host/mcp` using Maple's supported API-key or
   OAuth authentication. Chat is available in the dashboard; transcripts survive restart.

The web image resolves API URLs from the browser's origin, so changing the hostname does not require a
frontend rebuild. Nginx streams chat responses and hides `/v0/*`. Maple's dashboard
also uses `/internal/*`; those routes retain the application's authentication.
The Rust gateway verifies actual PostgreSQL-backed ingest keys before accepting data.
Replay payloads stay inline in ClickHouse; no R2 bucket is needed.

## Uptime

The `scraper` service runs HTTP, TCP and DNS checks automatically. It reuses the server
image and `INTERNAL_SERVICE_TOKEN`; no extra secrets, public ports or Cloudflare services
are needed. Keep one scraper replica to avoid duplicate checks. It also runs any configured
Prometheus scrape targets.

In **Alerts**, open the arrow beside **New rule**, choose **Uptime check**, configure the
target and interval, then select **Create monitor**. Results appear in the **Uptime** tab;
new or changed monitors are picked up within the default 60-second refresh interval.
Checks run from your Docker host, even where the upstream dashboard says "Ashburn, US".
The probes retain upstream's protection against private, loopback and reserved addresses.

For cron jobs or private services, choose **Heartbeat** and send a request to the ping URL
shown after creation (`https://your-host/hb/<token>`). Send to its `/fail` suffix to report
a failure. Nginx forwards both routes to Maple without logging the heartbeat token.
The existing alerting scheduler evaluates failures and missed heartbeats.

Use `docker compose --env-file deploy/self-hosted/.env -f deploy/self-hosted/compose.yaml logs scraper`
to diagnose missing checks. The scraper's health check fails when its target lists go stale.
Monitoring shares the Maple host, so a host outage also stops its checks and alert evaluation.

## Local verification

Copy `.env.example` to `.env`, fill it in and set the public origin to your local URL.
Run from the repository root:

```sh
docker compose --env-file deploy/self-hosted/.env -f deploy/self-hosted/compose.yaml -f deploy/self-hosted/compose.build.yaml up --build -d
docker compose --env-file deploy/self-hosted/.env -f deploy/self-hosted/compose.yaml ps
```

For local browser access, add an override file with `services.web.ports: ["127.0.0.1:8080:80"]`
and pass it as a second `-f` argument. Dokploy supplies routing, so the deployment itself
does not publish host ports.

## Persistence and updates

Back up the `postgres`, `clickhouse`, `chat` and `ingest-wal` volumes together with the
environment secrets. Stop Maple before copying SQLite files, including their WAL files;
use native database backup tools for PostgreSQL and ClickHouse. Keep backups before an
upgrade: application rollbacks do not reverse schema migrations. Never use `down -v`
against data you intend to keep.

The gateway acknowledges durable local WAL writes and retries export failures. As with
the upstream gateway, a retry after an ambiguous network failure may duplicate telemetry;
the WAL is not an exactly-once delivery guarantee. The upstream exporter also drops a batch
after exhausting its configured retry limit (20 attempts by default). Watch export failures,
disk space and gateway readiness; an extended warehouse outage can lose telemetry.

The internal adapter implements Maple's `/v0/events` writes and `/v0/sql` discovery reads. It projects the
schema's JSON paths and pins `OrgId` to `default`. It acknowledges only after ClickHouse
accepts the insert. Queries use a separate SELECT-only account; ingestion uses a
writer account with SELECT/INSERT and temporary-table access (required by ClickHouse's
input function and materialized views). Do not enable BYO-ClickHouse routing for this organization: this
deployment already configures its managed warehouse locally.

## Boundaries

- Cloud-specific GitHub/PlanetScale queue integrations, security audit workflows, repository sandbox execution,
  chat connector bots and email delivery are not configured by this deployment.
- AI chat, MCP tools, investigations and browser replay storage do not need those
  integrations. Model API calls require a working provider key and incur provider usage.
- Local SQLite sessions and rate-limit counters belong to one process. This deployment
  does not provide horizontal scaling or failover.

The older `apps/api/Dockerfile` and root development Compose are separate paths. For this
deployment use the Compose file above and its Dockerfile.
