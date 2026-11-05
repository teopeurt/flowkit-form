# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.14 AS build

WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true bun install --frozen-lockfile --ignore-scripts --filter @flowkit-demo/web
COPY apps/web apps/web
COPY packages/ui packages/ui
RUN bun run --cwd apps/web build

FROM nginx:1.27-alpine

COPY deploy/docker/nginx-spa.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/apps/web /usr/share/nginx/html
EXPOSE 8080
