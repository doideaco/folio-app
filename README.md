# folio-backend

Minimal Folio API — auth, boards, saves, cursor-based sync, and a stubbed
extraction pipeline. Runs locally with **zero external secrets**.

Stack: Fastify · Postgres (raw SQL via `pg`) · `jose` (JWT) · `zod`. Sync is a
monotonic `change_log` sequence. Extraction runs in-process in stub mode and
drives the real `pending → processing → ready` state machine.

## Run

```bash
cp .env.example .env
docker compose up -d          # Postgres on host port 5433
npm install
npm run migrate               # apply src/schema.sql (idempotent)
npm run seed                  # optional: dev user 'alex' + a board
npm run dev                   # http://localhost:3000
```

## Core loop over curl

```bash
TOKEN=$(curl -s localhost:3000/auth/apple -H 'content-type: application/json' \
  -d '{"dev_user":"alex","handle":"alex"}' | jq -r .token)

BOARD=$(curl -s localhost:3000/boards -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"name":"Dinners","emoji":"🍝","kind":"shared"}' | jq -r .id)

curl -s localhost:3000/saves -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"source_url\":\"https://www.instagram.com/reel/ABC123/\",\"board_id\":\"$BOARD\",\"type_guess\":\"recipe\"}"

curl -s "localhost:3000/sync" -H "authorization: Bearer $TOKEN"   # poll: card goes pending -> ready
```

## Endpoints

`POST /auth/apple` · `GET/POST /boards` · `POST /boards/:id/invite` ·
`POST /boards/join` · `POST /saves` · `GET /sync?since=` ·
`POST /cards/:id/comments` · `PATCH /cards/:id` · `DELETE /cards/:id`

## Config flags (`.env`)

- `AUTH_DEV_BYPASS=true` — accept `{dev_user, handle}` logins with no Apple token.
- `EXTRACTION_MODE=stub` — deterministic offline extractors.

## Deferred (not milestone 1)

Real Apple token verification is wired (set `AUTH_DEV_BYPASS=false` + `APPLE_CLIENT_ID`).
APNs push, nightly stale-check, 30-day provenance cleanup, and live
oEmbed/LLM/Places extractors are stubbed or not yet implemented.
