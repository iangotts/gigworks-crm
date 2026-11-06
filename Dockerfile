# GW-CRM: one container serves the API and the web screens. Built for Railway.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci
COPY . .
RUN npm run build && cd web && npm run build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY db ./db
USER node
EXPOSE 3000
# Migrations run first, so a deploy that adds a table is ready before it takes requests.
CMD ["sh", "-c", "node dist/cli/migrate.js && exec node dist/server.js"]
