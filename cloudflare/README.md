# Folio email-to-save (Cloudflare Email Routing)

Forward a flight/hotel/concert confirmation to your personal Folio address and it
becomes a card on the right board automatically.

```
inbound email → Cloudflare Email Routing → this Worker (parses MIME)
             → POST /inbound/email (Bearer INBOUND_SECRET) → Folio backend
             → parse JSON-LD / .ics / heuristics → pick board → create card → sync
```

## One-time setup

### 1. A domain on Cloudflare
You need a domain (e.g. `getfolio.app`) added to your Cloudflare account. Email
Routing needs the domain's nameservers on Cloudflare (Cloudflare adds the MX +
SPF records for you when you enable Email Routing).

We use a subdomain for inbound so it can't clash with normal mail: **`in.getfolio.app`**.
- Dashboard → your domain → **Email → Email Routing → Enable**.
- Add the MX/TXT records it suggests (for the zone; for a subdomain, add MX
  records for `in` pointing at Cloudflare's mail servers, or enable routing on
  the subdomain zone).

### 2. Deploy the Worker
```bash
cd cloudflare
npm install
npx wrangler login
npx wrangler secret put FOLIO_INBOUND_SECRET   # paste the same value as the backend
npx wrangler deploy
```
Edit `wrangler.toml` → `FOLIO_BACKEND_URL` if the backend URL differs.

### 3. Route mail to the Worker
Dashboard → Email → Email Routing → **Routes**:
- Add a **catch-all** rule for the `in.getfolio.app` zone → **Send to a Worker →
  `folio-email`**. (Catch-all so every `<token>@in.getfolio.app` reaches it.)

### 4. Backend secrets (Fly)
```bash
fly secrets set INBOUND_SECRET=<same-value-as-worker> INBOUND_DOMAIN=in.getfolio.app -a folio-doidea
```
Inbound is disabled until `INBOUND_SECRET` is set (the webhook returns 503).

## Using it
- The app shows your address (`GET /inbound/address`), e.g. `alex-3f9c@in.getfolio.app`.
- Forward a confirmation email there, or set a Gmail filter to auto-forward
  airline/hotel/ticket senders.
- Boards are chosen from the content: flights & hotels → **Trips ✈️**, concerts &
  tickets → **Events 🎫**, everything else → **Inbox 📥** (auto-created).

## Local test (no email needed)
With `INBOUND_SECRET` set on the backend you can POST a sample payload directly:
```bash
curl -sX POST "$BASE/inbound/email" \
  -H "authorization: Bearer $INBOUND_SECRET" -H 'content-type: application/json' \
  -d '{"to":"<yourtoken>@in.getfolio.app","from":"noreply@ba.com","subject":"Booking",
       "html":"<script type=\"application/ld+json\">{\"@type\":\"FlightReservation\",\"reservationFor\":{\"@type\":\"Flight\",\"flightNumber\":\"BA2490\",\"airline\":{\"name\":\"British Airways\"},\"departureAirport\":{\"iataCode\":\"LHR\"},\"arrivalAirport\":{\"iataCode\":\"JFK\"},\"departureTime\":\"2026-03-12T18:00:00Z\"}}<\/script>"}'
```
