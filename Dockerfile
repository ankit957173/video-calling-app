# ── Stage 1: build React frontend ─────────────────────────────────────────────
FROM node:20-alpine AS client-build

WORKDIR /app/client

COPY client/package.json client/package-lock.json ./
RUN npm ci

COPY client/ ./
RUN npm run build

# ── Stage 2: Python signaling server + static files ───────────────────────────
FROM python:3.12-slim

WORKDIR /app

COPY server/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY server/ ./
COPY --from=client-build /app/client/dist ./static

ENV PORT=8080
EXPOSE 8080

CMD uvicorn main:socket_app --host 0.0.0.0 --port ${PORT}
