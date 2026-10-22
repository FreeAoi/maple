FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile && bun run alchemy:build-deps

FROM build AS server
RUN mkdir -p /var/lib/maple/chat && chown -R bun:bun /var/lib/maple
USER bun
EXPOSE 3472
CMD ["bun", "run", "--cwd", "apps/self-hosted", "start"]

FROM build AS web-build
ENV VITE_API_BASE_URL=/ VITE_ELECTRIC_SYNC_URL=/ VITE_INGEST_URL=/ingest VITE_MAPLE_AUTH_MODE=self_hosted
ENV VITE_MAPLE_CAPTURE=off VITE_MAPLE_REPLAY=off
RUN bun run --cwd apps/web build

FROM nginx:1.28-alpine AS web
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/self-hosted/proxy.conf /etc/nginx/maple-proxy.conf
RUN sed -i '/listen 80;/a\    include /etc/nginx/maple-proxy.conf;' /etc/nginx/conf.d/default.conf \
    && printf 'limit_req_zone $binary_remote_addr zone=login:1m rate=5r/m;\n' > /etc/nginx/conf.d/limits.conf
EXPOSE 80
