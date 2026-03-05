# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app/packages/mcp

COPY packages/mcp/package*.json ./
RUN npm ci

COPY packages/mcp/tsconfig.json ./tsconfig.json
COPY packages/mcp/src ./src

RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/packages/mcp/package.json ./package.json
COPY --from=build /app/packages/mcp/node_modules ./node_modules
COPY --from=build /app/packages/mcp/dist ./dist

CMD ["node", "dist/index.js"]
