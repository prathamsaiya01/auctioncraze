# AuctionCraze

Independent multiplayer IPL-style cricket auction gaming platform.

## Architecture Overview
- `apps/web`: Next.js 14 (App Router), Tailwind CSS, Framer Motion, TanStack Query, Zustand (Port `3001`)
- `apps/api`: Node.js, Express, Socket.IO + Redis Adapter, ioredis, Zod, Prisma (Port `4001`)
- `packages/shared`: Enums, IPL franchise presets, Zod schemas, Socket event contracts, TypeScript DTOs
- `packages/database`: Independent PostgreSQL 16 + Prisma schema (`auctioncraze_db`)
- `packages/auction-engine`: Deterministic bid increment, overseas cap, squad reserve, and timer validation
- `services/ml`: Independent Python + FastAPI ML intelligence architecture (Models 1–5; zero auction buying/bidding advice)
- `infrastructure/docker`: Independent PostgreSQL (`5433`) & Redis (`6380`) services

## Quick Start
```bash
# 1. Start PostgreSQL (5433) and Redis (6380)
docker compose -f infrastructure/docker/docker-compose.yml up -d

# 2. Install dependencies
npm install

# 3. Push schema & generate Prisma client
npm run db:generate
npm run db:push
npm run db:seed

# 4. Run development servers (API :4001, Web :3001)
npm run dev
```
