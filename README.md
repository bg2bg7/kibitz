# Kibitz Chess Suite

Privacy-first, open-source chess education, coaching, and club-management monorepo built around the **PGNA v1.0** (`.pgna`) narrated-workbook format.

Licensed under the **GNU Affero General Public License v3.0 (`AGPL-3.0-only`)**. See [`LICENSE`](./LICENSE).

---

## Quickstart

### Prerequisites

- Node.js `>= 22`
- `pnpm` (`>= 9`, pinned via `packageManager` in root `package.json`)
- Docker & Docker Compose (for local PostgreSQL 16 + MinIO S3 storage)

### 1. Environment & Local Infrastructure

```bash
cp .env.example .env
docker compose up -d
```

This starts:

- **PostgreSQL 16** on `localhost:5432` (`kibitz_suite`)
- **MinIO (S3-compatible `.pgna` storage)** on `localhost:9000` (Console: `http://localhost:9001`), auto-creating the `kibitz-pgna` bucket.

### 2. Install Dependencies & Apply Database Schema

```bash
pnpm install
pnpm db:push
# Or generate & run versioned Drizzle SQL migrations:
# pnpm db:generate
# pnpm db:migrate
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

- `apps/id` — Invite-only identity, cross-subdomain JWT/sessions, double-blind linking (`:4001` / `:5171`)
- `apps/kibitz` — Moderated `.pgna` lecture library, public primers, assignments (`:4002` / `:5172`)
- `apps/hall` — Private scheduled club tournament WS server + minimal client (`:4003` / `:5173`)
- `apps/scribe` — Client-first PGNA v1.0 authoring studio (`:5174`)
- `apps/arbiter` — 100% offline Zero-PII club & tournament manager PWA (`:5175`)
- `apps/seconds` — 100% offline Zero-PII parent & classroom utility kit PWA (`:5176`)
- `packages/*` — `@suite/tsconfig`, `@suite/chess-core`, `@suite/pgna`, `@suite/board-ui`, `@suite/print-kit`, `@suite/auth-core`, `@suite/db`, `@suite/ui`

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the full dependency graph, privacy boundaries, and hybrid app conventions.
