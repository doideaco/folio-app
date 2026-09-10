# Deploying the Folio backend — Fly.io + Neon (free/cheap)

Off-network devices (TestFlight, friends' phones) need a **public HTTPS** backend
(also satisfies iOS ATS with no exception). We run the Node service on **Fly.io**
(scale-to-zero, so idle ≈ $0) and Postgres on **Neon** (free, always-on). The
backend self-applies its schema on boot and listens on `$PORT` (Fly sets this).

## 1. Postgres on Neon (free)

1. Create a project at <https://neon.tech>.
2. Copy the **connection string** (looks like
   `postgresql://user:pass@ep-xxx.eu-west-2.aws.neon.tech/neondb?sslmode=require`).
   Neon requires TLS — the backend enables SSL automatically for any non-local
   `DATABASE_URL`, so this works as-is.

## 2. Service on Fly.io

Install the CLI once: `brew install flyctl`, then `fly auth login`.

From `folio-backend/`:

```sh
fly launch --no-deploy          # creates the app from fly.toml + Dockerfile
                                # (keep the app name "folio-backend" or update
                                #  fly.toml + the app's hostedBaseURL to match)

# Secrets (never commit these):
fly secrets set \
  DATABASE_URL="postgresql://…neon…?sslmode=require" \
  SESSION_JWT_SECRET="$(openssl rand -hex 32)" \
  APPLE_CLIENT_ID="com.thedoidea.co.Folio" \
  EXTRACTION_MODE="live" \
  AUTH_DEV_BYPASS="true"         # flip to "false" once real Apple sign-in is verified

fly deploy
fly secrets set PUBLIC_BASE_URL="https://$(fly info --json | jq -r .Hostname)"  # for invite links
```

Verify: `curl https://folio-backend.fly.dev/healthz` → `{"ok":true}`.

Scale-to-zero is configured in `fly.toml` (`min_machines_running = 0`,
`auto_stop_machines = "stop"`). The first request after idle cold-starts in a few
seconds, then it's warm.

### Auth note
`AUTH_DEV_BYPASS=true` lets the app's Developer sign-in work against the hosted
backend for a first smoke test. For real accounts set it to `false` (sign-in then
uses **real** Apple identity tokens verified against `APPLE_CLIENT_ID`).

## 3. Point the app at it

`Folio/Folio/App/AppEnvironment.swift` already switches by build config:

```swift
static let hostedBaseURL = URL(string: "https://folio-backend.fly.dev")!  // release
static let devBaseURL    = URL(string: "http://Alexs-Mac-Studio-8.local:3000")!  // debug
```

Update `hostedBaseURL` if your Fly app name differs. Debug builds keep using the
Mac; **Release/Archive builds** use Fly over HTTPS (no ATS exception needed).

## 4. Ship to TestFlight

1. Xcode → destination **Any iOS Device (arm64)**.
2. **Product → Archive** → Organizer opens.
3. **Distribute App → App Store Connect → Upload** (automatic signing handles the
   app + FolioShare extension).
4. **App Store Connect → TestFlight** → add testers. First upload needs the basic
   export-compliance answer (no non-exempt encryption).
5. Install via TestFlight — the share extension persists like a normal install.

## Costs
- **Neon**: free tier (0.5 GB, always-on).
- **Fly**: pay-as-you-go; a single `shared-cpu-1x` / 256–512 MB machine that
  scales to zero costs cents/month for light use. Requires a card on file.
