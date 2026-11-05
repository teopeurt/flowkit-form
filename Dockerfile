# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.14 AS workspace
WORKDIR /app

COPY package.json bun.lock bunfig.toml tsconfig.json tsconfig.build.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/notify-worker/package.json apps/notify-worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/ui/package.json packages/ui/package.json

FROM workspace AS dependencies
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true bun install --frozen-lockfile --ignore-scripts

FROM dependencies AS build
COPY . .
RUN bun run build

FROM workspace AS production-dependencies
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true bun install --frozen-lockfile --production --ignore-scripts

FROM oven/bun:1.3.14 AS production
ENV NODE_ENV=production
WORKDIR /app

COPY --from=production-dependencies /app/node_modules /app/node_modules
COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/bunfig.toml /app/bunfig.toml
COPY --from=build /app/apps /app/apps
COPY --from=build /app/packages /app/packages
COPY --from=build /app/scripts /app/scripts
COPY --from=build /app/dist /app/dist

USER bun
EXPOSE 3011
CMD ["bun", "run", "apps/api/src/main.ts"]
