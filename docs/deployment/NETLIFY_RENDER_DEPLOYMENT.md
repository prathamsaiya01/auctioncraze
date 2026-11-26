# AuctionCraze Production & Staging Deployment Guide (Netlify + Render)

This document defines the exact deployment architecture, configuration, migration workflow, environment variables, health checks, rollback strategy, and verification steps for **AuctionCraze**.

---

## 1. Architecture Diagram

```text
User Browser / Mobile
   │
   ├── HTTPS (Next.js 14 App Router + OpenGraph SSR)
   │      └── Netlify CDN + OpenNext (`apps/web`)
   │            • Uses NEXT_PUBLIC_API_URL & NEXT_PUBLIC_SOCKET_URL
   │            • Sends Authorization: Bearer <JWT>
   │
   └── HTTPS REST + WSS Socket.IO (`wss://`)
          └── Render Persistent Web Service (`auctioncraze-api`, Always-On, Paid Tier)
                 │
                 ├── Render Private Network ──► Render PostgreSQL 16 (`auctioncraze-db`, `basic-256mb`+)
                 │                               • Row-level `FOR UPDATE` transactions + Prisma migrations
                 │
                 ├── Render Private Network ──► Render Key Value (`auctioncraze-redis`, `noeviction`)
                 │                               • 250ms AuctionTimerManager ZSET, SET NX locks, rate limits, Socket.IO pub/sub
                 │
                 └── Render Private Network ──► Render Private Service (`auctioncraze-ml`, FastAPI + Uvicorn)
                                                 • Internal-only (`pserv`), protected by `X-Internal-Service-Key`
```

---

## 2. Netlify Frontend Setup (`apps/web`)

Root configuration lives in [netlify.toml](../../netlify.toml):
- **Repository / Branch**: `prathamsaiya01/auctioncraze` (`main`)
- **Base directory**: `.` (monorepo root so `@auctioncraze/shared` builds cleanly)
- **Build command**: `npm run build --workspace=@auctioncraze/shared && npm run build --workspace=@auctioncraze/web`
- **Publish directory**: `apps/web/.next`
- **Node version**: `22` (`NODE_VERSION = "22"`)
- **Plugin**: `@netlify/plugin-nextjs`

### Netlify Environment Variables
Set these in **Netlify Site Configuration -> Environment variables** before triggering a production/staging build (since `NEXT_PUBLIC_*` variables are compiled into the frontend bundle and read by SSR metadata layouts):

| Variable | Visibility | Example Staging / Prod Format | Purpose |
| :--- | :--- | :--- | :--- |
| `NEXT_PUBLIC_APP_URL` | Public | `https://auctioncraze-staging.netlify.app` (or custom domain) | Sets Next.js `metadataBase` + SSR invite link base URL fallback (`shareLinks.ts`). |
| `NEXT_PUBLIC_API_URL` | Public | `https://auctioncraze-api.onrender.com/api/v1` | REST base URL for Axios client + OpenGraph `generateMetadata`. |
| `NEXT_PUBLIC_SOCKET_URL` | Public | `https://auctioncraze-api.onrender.com` | Socket.IO endpoint (upgrades to `wss://`). |

> **Never put `JWT_SECRET`, `INTERNAL_ML_SERVICE_KEY`, `DATABASE_URL`, or `REDIS_URL` into Netlify.**

---

## 3. Render Backend, Database, Key Value & ML Setup

Root Blueprint lives in [render.yaml](../../render.yaml). All 4 services share `region: singapore` so internal networking has minimal latency and zero public egress.

1. **`auctioncraze-db`** (Render PostgreSQL 16, `plan: basic-256mb` or higher for production, `ipAllowList: []` private-only)
   - Never use Render Free PostgreSQL for staging/production persistence (expires after 30 days).
2. **`auctioncraze-redis`** (Render Key Value, `plan: 256mb` or higher, `maxmemoryPolicy: noeviction`, `ipAllowList: []`)
   - `256mb`+ ensures disk persistence (and uses valid Key Value memory-tier plan identifiers `256mb`, `1g`, `5g`, etc.); `noeviction` guarantees auction timers (`auction:active_timers`) and close locks (`lock:timer-close:*`) are never evicted under memory pressure.
3. **`auctioncraze-ml`** (Render Private Service `type: pserv`, `runtime: python`, `rootDir: services/ml`, `plan: starter` -> upgrade to `standard` 2 GB RAM if inference/audit memory peaks exceed 512 MB)
   - No public URL is created; only `auctioncraze-api` can reach it inside Render's private network.
4. **`auctioncraze-api`** (Render Web Service `type: web`, `runtime: node`, `plan: starter` or `standard`, `numInstances: 1`, `healthCheckPath: /health`)
   - Must stay always-on (never free tier, which sleeps after 15 minutes and drops WebSockets + the 250ms auction timer engine).
   - Runs `npm run db:migrate:deploy` automatically in `preDeployCommand` before cutover.

---

## 4. Database Migration & Initial Seed Procedure

### Production / Staging Migrations (NEVER run `prisma db push`)
Baseline SQL migration lives at `packages/database/prisma/migrations/20261126000000_init/migration.sql`.

1. **Automated on Render Deploys**: `render.yaml` configures `preDeployCommand: npm run db:migrate:deploy` (`prisma migrate deploy`), executing only pending migrations after build and before routing traffic to the new container.
2. **Manual Staging/Production Verification**:
   ```bash
   DATABASE_URL="<TARGET_DB_URL>" npx prisma migrate status --schema=packages/database/prisma/schema.prisma
   DATABASE_URL="<TARGET_DB_URL>" npm run db:migrate:deploy
   ```
3. **One-Time Baseline Existing DB (only if migrating an existing pre-Prisma-Migrate DB)**:
   ```bash
   npx prisma migrate resolve --applied 20261126000000_init --schema=packages/database/prisma/schema.prisma
   ```
4. **Initial Player Catalog Seed** (idempotent across `MasterPlayer`, safe on fresh database):
   Run once from the Render API Shell (or repo root targeting staging `DATABASE_URL`):
   ```bash
   npm run db:seed
   ```
   *(Reads `services/ml/data/processed/ipl_players.csv` and `ipl_season_stats.csv`, both tracked in Git.)*

---

## 5. Complete Environment Variable Checklist

### A. Netlify Frontend
- `NEXT_PUBLIC_APP_URL` *(Public, prod HTTPS URL)*
- `NEXT_PUBLIC_API_URL` *(Public, prod `https://<api>/api/v1`)*
- `NEXT_PUBLIC_SOCKET_URL` *(Public, prod `https://<api>`)*

### B. Render API (`auctioncraze-api`)
- `NODE_ENV=production`
- `TRUST_PROXY_HOPS=1` *(Bounded reverse-proxy hop count; rejects client-forged `X-Forwarded-For` chains)*
- `CORS_ORIGIN` *(Exact comma-separated HTTPS frontend URLs; wildcard `*` and `localhost` are rejected in production)*
- `JWT_SECRET` *(Secret, generated 32+ chars / 64+ recommended, distinct from ML key)*
- `JWT_EXPIRES_IN=7d`
- `GUEST_SESSION_TTL_SECONDS=604800`
- `DATABASE_URL` *(Secret, injected by `fromDatabase`)*
- `REDIS_URL` *(Secret, injected by `fromService: keyvalue`)*
- `ML_SERVICE_URL` *(Internal `host:port` injected by `fromService: pserv`, normalized to `http://host:port`)*
- `INTERNAL_ML_SERVICE_KEY` *(Secret, copied from `auctioncraze-ml`)*

### C. Render ML (`auctioncraze-ml`)
- `PYTHON_VERSION=3.12.8`
- `INTERNAL_ML_SERVICE_KEY` *(Secret, generated 32+ chars, shared exclusively with Render API)*

### D. Render PostgreSQL & Key Value
- Provisioned privately in `singapore` with `ipAllowList: []` (`DATABASE_URL` & `REDIS_URL` managed by Render).

> Startup fails fast (`env.ts`) in `production` if any required URL/secret is missing, points to `localhost`, uses placeholder text, sets wildcard CORS `*`, sets boolean `TRUST_PROXY_HOPS`, or reuses the same value for `JWT_SECRET` and `INTERNAL_ML_SERVICE_KEY`.

---

## 6. Deployment Sequence

1. **Create Render Blueprint (`render.yaml`)** in Render Dashboard -> review resource plans -> create PostgreSQL, Key Value, Private ML Service, and Web API.
2. **Wait for ML Private Service & Datastores to become healthy**, then run **one-time catalog seed** (`npm run db:seed`) on the newly migrated `auctioncraze-db` via Render Shell.
3. **Verify Render API `/health`** returns `200` (`postgres: "up"`, `redis: "up"`).
4. **Connect GitHub repository in Netlify** (`prathamsaiya01/auctioncraze`, `main`) with `NEXT_PUBLIC_API_URL` & `NEXT_PUBLIC_SOCKET_URL` pointing to Render API HTTPS URL, and deploy frontend.
5. **Update `CORS_ORIGIN` on `auctioncraze-api`** with the exact Netlify HTTPS URL (and custom domain once attached) + ensure Netlify `NEXT_PUBLIC_APP_URL` matches it, then trigger a clean Netlify rebuild so `metadataBase` matches the final domain.

---

## 7. Health Check URLs

- **API Health (Public)**: `GET https://<api-domain>/health` -> Expected HTTP `200`:
  `{"status":"healthy","service":"auctioncraze-api","dependencies":{"postgres":"up","redis":"up"}}`
- **ML Health (Internal Private Network Only)**: `GET http://<ml-private-hostport>/health` -> Expected HTTP `200`:
  `{"status":"healthy","service":"auctioncraze-ml","allow_bidding_advice":false}`
- **Frontend Root**: `GET https://<frontend-domain>/` -> HTTP `200`

---

## 8. Rollback Procedure

1. **Frontend Rollback (Netlify)**: In Netlify **Deploys**, click **Publish deploy** on the previous verified green build (takes seconds).
2. **API / ML Rollback (Render)**: In Render Dashboard -> service **Events / Deploys**, select the previous good commit and trigger **Rollback to this deploy** (note `preDeployCommand` only runs forward idempotent migrations; never run destructive schema drops on production DB).
3. **Database Schema Rollback Safety**: If a new migration fails during `preDeployCommand`, Render aborts the deploy **before** cutting over live traffic. Restore from Render PostgreSQL automated daily snapshot/PITR only if data corruption occurred.

---

## 9. Common Deployment Errors & Solutions

| Symptom | Root Cause | Fix |
| :--- | :--- | :--- |
| API exits immediately on boot (`Security error` / `Configuration error`) | Missing/short secret, `localhost` URL, placeholder text, or missing `CORS_ORIGIN` under `NODE_ENV=production` | Verify Render env vars (`JWT_SECRET`, `INTERNAL_ML_SERVICE_KEY`, `DATABASE_URL`, `REDIS_URL`, `ML_SERVICE_URL`, `CORS_ORIGIN`). |
| CORS blocked on browser or WebSocket handshake fails | Netlify domain (or trailing slash mismatch) omitted from `CORS_ORIGIN` | Set `CORS_ORIGIN=https://your-site.netlify.app` cleanly without trailing `/`. |
| Guest sessions return 429 unexpectedly for different users | `TRUST_PROXY_HOPS` overridden to `0` behind Render proxy | Keep `TRUST_PROXY_HOPS=1` on Render Web Service. |
| ML intelligence calls return `503 ML_SERVICE_UNAVAILABLE` or OOM | Private ML service exceeded 512 MB Starter RAM under XGBoost/LightGBM load | Check Render ML logs/metrics and upgrade `auctioncraze-ml` plan from `starter` to `standard` (2 GB). |
| OpenGraph preview missing site title or showing fallback | Netlify build triggered before `NEXT_PUBLIC_APP_URL` / `NEXT_PUBLIC_API_URL` were set | Populate all 3 `NEXT_PUBLIC_*` vars in Netlify and redeploy with cleared cache. |
| Netlify build fails cannot find `@auctioncraze/shared` | Base directory set to `apps/web` instead of `.` or shared workspace skipped | Keep `netlify.toml` at repo root (`base = "."`, shared build before web build). |

---

## 10. Staging Verification Checklist

- [ ] `GET https://<api>/health` returns HTTP `200` (`postgres: up`, `redis: up`).
- [ ] Private ML `/health` reachable from API container; public internet cannot reach ML directly.
- [ ] `npx prisma migrate status` reports zero pending migrations and `players` catalog is seeded.
- [ ] Create public + private room on Netlify staging URL over HTTPS (`wss://` Socket.IO connected).
- [ ] Test Room & Season Invite URLs across desktop + incognito + mobile viewport (zero `localhost` URLs in links or HTML `<meta>` tags; private rooms do not leak room name in SSR OpenGraph).
- [ ] Run live 2-owner bid cycle + timer countdown expiry + simulated API restart timer recovery via Redis/PostgreSQL.
- [ ] Verify RBAC on `/intelligence` (visitor `401`, spectator `403`, own franchise `200`, rival franchise `403`).
- [ ] Verify NAT / IP rate-limiting behavior behind Render proxy (`X-RateLimit-Limit` / `429` enforcement).
