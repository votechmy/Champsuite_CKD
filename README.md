# ChampSuite CKD

Internal tool for the Cards & Hobbies buyer team. Mirrors the Card Kingdom MTG pricelist (`https://api.cardkingdom.com/api/v2/pricelist`, ~146k rows) into Supabase, keeps 30 days of price history, and exposes a searchable list view.

## Architecture

```
GitHub Actions (cron 08:00 UTC + manual workflow_dispatch)
    └── scripts/sync-cardkingdom.ts
        ├── fetch CK pricelist
        ├── upsert cards (by id)
        ├── insert card_prices snapshot
        └── prune card_prices older than 30 days

Next.js (App Router, Vercel)
    ├── /             → status page (card count, last sync)
    ├── /list         → searchable / filterable / paginated table
    ├── /card/[id]    → detail + 30d history table
    └── /api/refresh  → POST → GH workflow_dispatch (rate-limited)

Supabase Postgres
    ├── cards               (identity, indexed by name/edition/sku)
    ├── card_prices         (time series, 30d retention)
    ├── card_prices_latest  (view: distinct on card_id, latest snapshot)
    └── sync_runs           (audit: started, finished, status, error)
```

## Setup

### 1. Supabase

1. Create a Supabase project.
2. Run `supabase/migrations/0001_init.sql` (Studio → SQL Editor → paste & run, or `supabase db push` if using the CLI).
3. Enable Email auth + an email allowlist for the buyer team (Auth → Providers → Email; restrict signups via auth hooks or a magic-link-only flow).

### 2. Local dev

```bash
pnpm install
cp .env.example .env.local
# fill in the Supabase URL + keys
pnpm dev          # http://localhost:3000
pnpm sync         # one-shot pull (uses service role key — careful)
pnpm typecheck
```

### 3. Vercel deploy

1. Import the GitHub repo into Vercel.
2. Set env vars from `.env.example`:
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` (server-only — do not expose)
   - `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_DISPATCH_TOKEN`, `GITHUB_WORKFLOW_FILE`
   - `REFRESH_COOLDOWN_SECONDS` (defaults to 600)
3. Deploy.

### 4. GitHub Actions

In the repo settings → Secrets and variables → Actions, add:

- `NEXT_PUBLIC_SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The workflow runs daily at 08:00 UTC and on manual dispatch. The `/api/refresh` button on the list page triggers a manual dispatch via the `GITHUB_DISPATCH_TOKEN` (a fine-grained PAT with `Actions: read & write` on this repo only).

## How the sync works

`scripts/sync-cardkingdom.ts`:

1. Opens a `sync_runs` row (`status='running'`).
2. Fetches the pricelist (~65 MB JSON, ~146k rows).
3. Upserts identity into `cards` in batches of 500 (`onConflict: id`).
4. Upserts a snapshot row into `card_prices` per card, in batches of 1000 (`onConflict: card_id,captured_at`). Re-running within the same second updates the same snapshot — idempotent.
5. Prunes `card_prices` rows older than 30 days. Only on success.
6. Closes the `sync_runs` row with totals + status.

On failure, the run row is updated to `status='failure'` with the error message, and the script exits non-zero (GH Actions surfaces it). The prune step does not run on failure, so you can never lose history because of a bad pull.

## Verification checklist

- [ ] `pnpm build` passes.
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm sync` against a dev Supabase project completes; row counts match the dump (~146k).
- [ ] `select count(*) from card_prices_latest` returns one row per card.
- [ ] List page loads in <1s, search/filter/sort work, pagination works.
- [ ] `/card/<id>` shows recent snapshots.
- [ ] GH Actions manual dispatch from the Actions tab completes <10 min.
- [ ] Refresh button triggers a new run; `/api/refresh` 429s if hit again within `REFRESH_COOLDOWN_SECONDS`.
- [ ] Backdated rows (`captured_at = now() - interval '31 days'`) get pruned on next successful sync.

## Out of scope (for now)

- No public-facing browse or SEO.
- No price-change alerts ("X moved >10%") — schema supports it; build when buyers ask.
- No alternate sources (TCGplayer etc.). Single endpoint only.
- No per-condition deep modeling beyond what CK returns in `condition_values`.
