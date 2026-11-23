# Kibitz Chess Suite

Privacy-first, open-source chess education, coaching, and club-management monorepo built around the **PGNA v1.0** (`.pgna`) narrated-workbook format.

Licensed under the **GNU Affero General Public License v3.0 (`AGPL-3.0-only`)**. See [`LICENSE`](./LICENSE).

---

## Quickstart

### Prerequisites

- Node.js `>= 22`
- `pnpm` (`>= 9`, pinned via `packageManager` in root `package.json`)
- Docker & Docker Compose (for local PostgreSQL 16 + RustFS S3-compatible storage)

### 1. Environment & Local Infrastructure

```bash
cp .env.example .env
```

Before starting Docker, populate freshly generated local credentials in `.env`:

- `POSTGRES_PASSWORD` (e.g. `openssl rand -hex 24`) and the matching password in `DATABASE_URL`
- `S3_ACCESS_KEY_ID` (e.g. `openssl rand -hex 12`) and `S3_SECRET_ACCESS_KEY` (e.g. `openssl rand -hex 24`)
- `AUTH_JWT_SECRET` (e.g. `openssl rand -base64 48`, required in production)
- _(Optional, first volume init only)_ Set `INITIAL_ADMIN_HANDLE` and `INITIAL_ADMIN_PASSWORD` (`<= 72` UTF-8 bytes, e.g. `openssl rand -base64 36`) to seed an initial admin account on an empty Postgres volume; leave both empty to skip admin seeding.

Then start the local services:

```bash
docker compose up -d
```

If you opted into initial admin seeding, clear `INITIAL_ADMIN_PASSWORD` from `.env` after initialization completes.

This starts:

- **PostgreSQL 16** bound to `127.0.0.1:5432` by default (`kibitz_suite`) — on first startup (empty volume), [`docker/postgres/init-db-and-admin.sh`](./docker/postgres/init-db-and-admin.sh) automatically applies all Drizzle migrations in `packages/db/drizzle/` and seeds an initial admin account **only** when both `INITIAL_ADMIN_HANDLE` and `INITIAL_ADMIN_PASSWORD` are explicitly non-empty.
- **RustFS (S3-compatible `.pgna` storage)** bound to `127.0.0.1:9000` (Console: `http://127.0.0.1:9001`) by default, auto-creating the `kibitz-pgna` bucket. Override `POSTGRES_BIND_HOST`, `S3_BIND_HOST`, or `S3_CONSOLE_BIND_HOST` only when intentionally exposing beyond loopback.

#### Credential Rotation & Existing Installs

Changing `.env` alone does **not** rotate credentials already persisted inside existing PostgreSQL (`kibitz_pgdata`) or RustFS (`kibitz_s3data`) volumes, nor does it remove an already-seeded admin account. On existing installs:

- Inventory exposed service ports and ensure local infrastructure is bound to loopback or firewalled.
- Rotate the PostgreSQL role password (`ALTER USER ... WITH PASSWORD ...`), existing admin account passwords, S3 access/secret keys, and `AUTH_JWT_SECRET` (which invalidates previously issued sessions).
- Inspect existing bootstrap accounts in `"users"` (or recreate disposable local development volumes with `docker compose down -v` before re-initializing).

### 2. Install Dependencies & Sync Database Migrations

```bash
pnpm install
pnpm db:migrate # Applies any newer Drizzle migrations added after initial volume creation
```

### 3. Run the Suite Locally

```bash
pnpm dev
```

Or run a single workspace (for example, offline `arbiter` or `kibitz`):

```bash
pnpm --filter @suite/arbiter dev
pnpm --filter @suite/kibitz dev
```

---

## Verification & Quality Gates

Run the full verification suite from the repository root:

```bash
pnpm verify:boundaries   # Audits package.json graphs + proves ESLint rejects Zero-PII/layer violations
pnpm typecheck           # Strict TypeScript checks across all packages & apps
pnpm lint                # ESLint v9 flat config + boundary rules
pnpm test                # Vitest unit & integration tests
pnpm build               # Full Turborepo build (packages -> servers -> Vite web/PWA bundles)
```

---

## Dropping in the PGNA v1.0 Reference Implementation

The canonical specification is tracked at [`docs/PGNA-v1.0.md`](./docs/PGNA-v1.0.md).

Drop your TypeScript PGNA v1.0 reference implementation directly into:

```text
packages/pgna/src/
```

Keeping the exported entrypoints aligned with `packages/pgna/package.json`:

- `packages/pgna/src/index.ts` (`.`)
- `packages/pgna/src/compiler.ts` (`./compiler`)
- `packages/pgna/src/validator.ts` (`./validator`)
- `packages/pgna/src/player.ts` (`./player`)
- `packages/pgna/src/zip.ts` (`./zip`)

---

## Workspace Overview

- `apps/kibitz` — Kibitz suite homepage & service directory (`:5170`)
- `apps/id` — Invite-only identity, cross-subdomain JWT/sessions, double-blind linking (`:4001` / `:5171`)
- `apps/lecture` — Moderated `.pgna` lecture library, public primers, assignments (`:4002` / `:5172`)
- `apps/hall` — Private scheduled club tournament WS server + minimal client (`:4003` / `:5173`)
- `apps/scribe` — Client-first PGNA v1.0 authoring studio (`:5174`)
- `apps/arbiter` — 100% offline Zero-PII club & tournament manager PWA (`:5175`)
- `apps/seconds` — 100% offline Zero-PII parent & classroom utility kit PWA (`:5176`)
- `packages/*` — `@suite/tsconfig`, `@suite/chess-core`, `@suite/pgna`, `@suite/board-ui`, `@suite/print-kit`, `@suite/auth-core`, `@suite/db`, `@suite/ui`

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full dependency graph, privacy boundaries, and hybrid app conventions.
