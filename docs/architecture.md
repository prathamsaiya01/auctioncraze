# AuctionCraze Independent Architecture

## Core Principles
1. **No Super Admin / Org Admin Hierarchy**: Any user can host a room with a secure guest session.
2. **Host Parity**: The room creator is `HOST` for room/auction flow controls, claims a franchise, and bids on equal footing with all other owners.
3. **Server-Authoritative State**: PostgreSQL (`5433`) stores persistent room, franchise, purse ledger, lot, bid (`idempotencyKey`), and event history; Redis (`6380`) coordinates distributed Socket.IO, rate limiting, and timers.
4. **Separated Auction Lifecycle**: `BIDDING_CLOSED` (timer expiry) is strictly separated from `PLAYER_SOLD` and `PLAYER_UNSOLD` (explicit Host action).
5. **Independent ML Service (`services/ml`)**: Python + FastAPI service for player ratings, performance predictions, team strength, Playing XI + Impact Player, and match predictions. Strictly prohibits auction purchasing or bidding advice.
