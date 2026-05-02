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

## Public read API (for Champ Suite and other internal tools)

Two public, CORS-enabled, read-only endpoints. No auth — the data is already public (CK pricelist is openly accessible). Add a shared header key later if abuse becomes real.

Base URL: `https://champsuite-ckd.vercel.app/api/v1` (replace with your Vercel URL).

### `GET /cards/by-scryfall/:scryfall_id`

Look up CK printings for a single Scryfall UUID. Returns 1–2 prints (foil + nonfoil). Use this for card detail pages, wishlists, single-card pricing.

```bash
curl https://champsuite-ckd.vercel.app/api/v1/cards/by-scryfall/a363bc91-8278-448e-9d5c-564e4b51eb62
```

```json
{
  "scryfall_id": "a363bc91-8278-448e-9d5c-564e4b51eb62",
  "prints": [
    {
      "finish": "nonfoil",
      "ck_id": 10000,
      "sku": "4ED-117",
      "name": "Abomination",
      "edition": "4th Edition",
      "variation": null,
      "ck_url": "https://www.cardkingdom.com/mtg/4th-edition/abomination",
      "scryfall_url": "https://scryfall.com/card/a363bc91-8278-448e-9d5c-564e4b51eb62",
      "price": { "retail": 0.35, "buy": 0.01 },
      "qty":   { "retail": 25,   "buying": 10 },
      "conditions": {
        "nm": { "price": 0.35, "qty": 0 },
        "ex": { "price": 0.28, "qty": 10 },
        "vg": { "price": 0.25, "qty": 15 },
        "g":  { "price": 0.18, "qty": 0 }
      },
      "captured_at": "2026-05-01T12:00:00.000Z"
    }
  ]
}
```

Errors: `400` invalid UUID, `404` no CK row matches.

### `POST /cards/bulk-prices`

Hot path. Take a list of Scryfall UUIDs (e.g. all SKUs in a Champ Suite inventory page) and return current CK prices for each. **Max 500 ids per request.**

```bash
curl -X POST https://champsuite-ckd.vercel.app/api/v1/cards/bulk-prices \
  -H "Content-Type: application/json" \
  -d '{
    "scryfall_ids": [
      "a363bc91-8278-448e-9d5c-564e4b51eb62",
      "f3a4d2e1-1234-5678-9abc-def012345678"
    ],
    "finish": "nonfoil"
  }'
```

`finish` is optional: `"nonfoil"` | `"foil"` | `"any"` (default). Omit to get all printings.

Response:

```json
{
  "captured_at_max": "2026-05-01T12:00:00.000Z",
  "found": 1,
  "missing": ["f3a4d2e1-1234-5678-9abc-def012345678"],
  "results": [
    {
      "scryfall_id": "a363bc91-8278-448e-9d5c-564e4b51eb62",
      "finish": "nonfoil",
      "ck_id": 10000,
      "sku": "4ED-117",
      "price_retail": 0.35,
      "price_buy": 0.01,
      "qty_retail": 25,
      "qty_buying": 10,
      "captured_at": "2026-05-01T12:00:00.000Z"
    }
  ]
}
```

`missing` contains scryfall_ids the caller asked for that have no CK row — useful for distinguishing "we have no data" from "Card Kingdom doesn't carry this printing."

### Champ Suite integration sketch

For a Champ Suite inventory list view that shows current CK prices alongside its own data:

```ts
// In a Vercel Function or React loader on the Champ Suite side.
const inv = await supabase
  .from('inventory')
  .select('scryfall_id, finish, quantity, ...')
  .eq('location_id', locationId);

const ids = [...new Set(inv.data.map((r) => r.scryfall_id))];

const ck = await fetch('https://champsuite-ckd.vercel.app/api/v1/cards/bulk-prices', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ scryfall_ids: ids }),
}).then((r) => r.json());

// Map: scryfall_id + finish → CK price row
const ckMap = new Map(
  ck.results.map((r) => [`${r.scryfall_id}:${r.finish}`, r]),
);

const enriched = inv.data.map((row) => ({
  ...row,
  ck: ckMap.get(`${row.scryfall_id}:${row.finish}`) ?? null,
}));
```

For chunks larger than 500: client-side, batch into 500-id slices and parallel-fetch (`Promise.all`).

### What this doesn't do (yet)

- **Etched finish.** CK doesn't always distinguish etched as a separate product. CKD only models `is_foil` (boolean). If you need etched lookups, we'd need to inspect CK's `variation` field for "etched" markers and add a third value to the `finish` enum. Open if Champ Suite asks.
- **Foreign-language lookups.** CK pricelist is English-only.
- **Price history endpoint.** Today only the latest snapshot is exposed via API. The 30-day history table exists in the DB — add `GET /cards/by-scryfall/:id/history` if Champ Suite wants charts.
- **Auth / rate limit.** Public read for now. Add a shared `x-api-key` header check later if abuse appears.

## Out of scope (for now)

- No public-facing browse or SEO.
- No price-change alerts ("X moved >10%") — schema supports it; build when buyers ask.
- No alternate sources (TCGplayer etc.). Single endpoint only.
- No per-condition deep modeling beyond what CK returns in `condition_values`.
