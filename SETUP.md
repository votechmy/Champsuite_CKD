# ChampSuite CKD — Setup Guide

End-to-end walkthrough to take this from `C:\ChampSuite CKD Test` (local scaffold) to a fully running internal tool with daily cron, manual refresh, and the daily health check routine. Total time: ~30–45 minutes if accounts are already created.

You will set up:

1. GitHub repo + first push
2. Supabase project + schema migration
3. Vercel project + environment variables + deploy
4. GitHub Actions secrets (so the cron worker can write to Supabase)
5. Fine-grained PAT (so the in-app "Refresh now" button can trigger workflow_dispatch)
6. First sync run + verification
7. Anthropic remote routine environment variables (so the daily health check can query Supabase)

---

## Prerequisites

- Node 20+ and `pnpm` installed locally. Verify: `node -v && pnpm -v`
- `gh` CLI installed and authenticated (`gh auth login`). Verify: `gh auth status`
- Accounts: GitHub, Supabase, Vercel, Anthropic (claude.ai)

---

## Step 1 — Push to GitHub

The remote routine and GH Actions cron both depend on this repo existing at `github.com/votechmy/Champsuite_CKD`.

```bash
cd "/c/ChampSuite CKD Test"

# Initialize git, commit, and push.
git init
git add .
git commit -m "initial scaffold"
git branch -M main

# Create the private repo under the votechmy org and push.
gh repo create votechmy/Champsuite_CKD --private --source=. --remote=origin --push
```

If the org doesn't exist yet, create it first at https://github.com/account/organizations/new, or use your personal account and adjust the routine source URL accordingly (`RemoteTrigger update`).

Verify: `gh repo view votechmy/Champsuite_CKD --web` opens the repo in a browser.

---

## Step 2 — Supabase project + migration

### 2a. Create the project

1. Go to https://supabase.com/dashboard/projects → **New project**.
2. Name: `champsuite-ckd` (or anything — this is the standalone project, not your existing ChampSuite one).
3. Region: pick the one closest to your buyer team. For Malaysia, **Southeast Asia (Singapore)** is the closest low-latency option.
4. Generate and **save the database password** somewhere safe (1Password, etc.). You won't need it for the app — only if you ever connect via psql.
5. Wait ~2 minutes for provisioning.

### 2b. Apply the schema

Open the project → **SQL Editor** → **New query** → paste the entire contents of `supabase/migrations/0001_init.sql` from this repo → click **Run**.

You should see `Success. No rows returned`. Then check the **Table Editor** — you should see `cards`, `card_prices`, and `sync_runs` tables, plus a `card_prices_latest` view.

### 2c. Grab the keys

Project → **Project Settings** → **API**:

- **Project URL** → this is `NEXT_PUBLIC_SUPABASE_URL` (e.g. `https://abcdefgh.supabase.co`)
- **Project API keys → `anon` public** → this is `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- **Project API keys → `service_role` (secret)** → this is `SUPABASE_SERVICE_ROLE_KEY` ⚠ never commit this, never expose it to a browser

### 2d. Auth (email allowlist for the buyer team)

Project → **Authentication** → **Providers** → **Email**:
- Enable Email
- **Disable "Enable email signups"** (so random people can't self-register)
- Use the **Invite users** flow under Authentication → Users to add buyer-team email addresses one by one. They'll get a magic-link email.

(Skip this step for now if you just want to ship — you can re-enable it later. The list page only checks server-side, so if Vercel is private/dev-only it's fine.)

---

## Step 3 — Vercel project + env vars + deploy

### 3a. Import the repo

1. Go to https://vercel.com/new
2. **Import Git Repository** → pick `votechmy/Champsuite_CKD`
3. Framework: **Next.js** (auto-detected)
4. Root directory: `.` (leave default)
5. **Don't deploy yet** — click **Environment Variables** first.

### 3b. Add env vars

Add each of these (Production + Preview + Development scope):

| Name | Value | Source |
|------|-------|--------|
| `NEXT_PUBLIC_SUPABASE_URL` | from Step 2c | Supabase API page |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | from Step 2c | Supabase API page |
| `SUPABASE_SERVICE_ROLE_KEY` | from Step 2c | Supabase API page (mark as **Sensitive**) |
| `CK_PRICELIST_URL` | `https://api.cardkingdom.com/api/v2/pricelist` | constant |
| `GITHUB_OWNER` | `votechmy` | the org/user name |
| `GITHUB_REPO` | `Champsuite_CKD` | repo name only, no slash |
| `GITHUB_DISPATCH_TOKEN` | (set in Step 5) | leave blank for now, come back |
| `GITHUB_WORKFLOW_FILE` | `sync.yml` | constant |
| `REFRESH_COOLDOWN_SECONDS` | `600` | adjust to taste |

### 3c. Deploy

Click **Deploy**. Wait ~2 min. You'll get a URL like `champsuite-ckd.vercel.app`. Visit it — you should see the home page showing **0 cards** and "No syncs yet."

(The "Refresh now" button will return an error until Step 5 — that's fine.)

---

## Step 4 — GitHub Actions secrets (for the cron worker)

The daily sync workflow (`.github/workflows/sync.yml`) runs in GitHub's runner and writes to Supabase using the service-role key. It needs two secrets:

```bash
# Run from the repo directory.
gh secret set NEXT_PUBLIC_SUPABASE_URL --repo votechmy/Champsuite_CKD
# (paste the Supabase URL when prompted)

gh secret set SUPABASE_SERVICE_ROLE_KEY --repo votechmy/Champsuite_CKD
# (paste the service-role key when prompted)
```

Or via UI: repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.

Verify: `gh secret list --repo votechmy/Champsuite_CKD` shows both names.

---

## Step 5 — Fine-grained PAT for `/api/refresh`

The "Refresh now" button POSTs to GitHub's `workflow_dispatch` endpoint. That requires a token with permission to start workflows on this specific repo.

### 5a. Create the PAT

1. Go to https://github.com/settings/personal-access-tokens/new
2. Token name: `champsuite-ckd-refresh-button`
3. Expiration: **1 year** (set a calendar reminder to rotate)
4. Resource owner: `votechmy` (the org)
5. Repository access: **Only select repositories** → `votechmy/Champsuite_CKD`
6. Repository permissions:
   - **Actions** → **Read and write** (this is the only one needed)
   - Leave everything else at "No access"
7. Click **Generate token**. **Copy it immediately** — you can't view it again.

### 5b. Add it to Vercel

Vercel project → **Settings** → **Environment Variables** → find `GITHUB_DISPATCH_TOKEN` → set the value to the PAT → mark **Sensitive** → save.

Then **redeploy** so the new env var takes effect: project → **Deployments** → click the latest → **⋯** → **Redeploy**.

---

## Step 6 — First sync + verification

### 6a. Trigger the sync from GitHub

```bash
gh workflow run sync.yml --repo votechmy/Champsuite_CKD --field triggered_by=initial-test
gh run watch --repo votechmy/Champsuite_CKD
```

Should complete in 5–10 minutes for ~146k rows. Watch for the line `[sync] run #1 success`.

### 6b. Verify in Supabase

Open the Supabase project → **Table Editor**:

- `cards` should have ~146,000 rows.
- `card_prices` should have ~146,000 rows (one snapshot per card).
- `sync_runs` should have one row with `status='success'` and matching counts.

Spot-check the latest snapshot view via SQL Editor:
```sql
select count(*) from card_prices_latest;
-- Should equal cards count.

select * from sync_runs order by started_at desc limit 1;
-- status='success', error is null.
```

### 6c. Verify in the app

Open the Vercel URL:

- **Home page** should now show the card count and "Last sync: ... — success".
- **`/list`** should load in <1s, show the first 50 cards alphabetically. Try searching "Lightning Bolt", filtering by edition, sorting by retail high→low.
- Click any card → **`/card/<id>`** → should show the detail and one history row.
- Click **Refresh now** → should return "Started — https://github.com/.../actions/...". Click again immediately → should 429 with "A manual sync ran Xs ago."

---

## Step 7 — Anthropic remote routine env vars

The daily health check routine (`trig_01TN66XvHpJFFBqm3Y1ffmuU`) runs in environment `env_015yHoxEmPfBJ1A1EMQcPpuy`. Without Supabase secrets there, it'll skip the data checks and report `STATUS: YELLOW`.

### 7a. Set the env vars

1. Go to the Anthropic Code environments page (linked from claude.ai/code/routines or accessible via the Anthropic console under your account → Code → Environments).
2. Find environment **Default** (`env_015yHoxEmPfBJ1A1EMQcPpuy`).
3. Add two environment variables:
   - `SUPABASE_URL` = the Supabase project URL from Step 2c (note: the prompt looks for `SUPABASE_URL`, not `NEXT_PUBLIC_SUPABASE_URL`)
   - `SUPABASE_SERVICE_ROLE_KEY` = the service-role key from Step 2c (mark as secret)

If the UI doesn't expose env vars on the environment yet, you can update the routine to bake them into the prompt — but **never** put a service-role key in a prompt. Better: wait until the env-var feature is available, or skip Supabase checks (the GH Actions check alone catches the most common failure mode).

### 7b. Test the routine

Run it manually once to make sure everything works before relying on the cron:

```bash
# (from a Claude Code session that has the schedule skill loaded)
# OR via the web UI:
```

Open https://claude.ai/code/routines/trig_01TN66XvHpJFFBqm3Y1ffmuU → **Run now**. Watch the session log:
- Should print `STATUS: GREEN ...` if everything's healthy.
- If `STATUS: YELLOW (Supabase skipped)` — env vars from Step 7a are missing.
- If `STATUS: RED ...` — open the issue it filed in `votechmy/Champsuite_CKD` and read the report.

---

## Done. What now?

- The cron runs daily 08:00 UTC and writes a fresh snapshot.
- The health check runs daily 21:00 UTC (5am MYT) and only nags on failure.
- Buyer team logs in via magic-link, browses the list, hits Refresh when they need fresher data.

### Things to schedule reminders for

- **Rotate the PAT** before its 1-year expiration — calendar reminder.
- **Watch storage growth** — at ~146k rows × 30 days × ~200 bytes/row ≈ 880 MB just for `card_prices`. Supabase free tier caps at 500 MB. Plan to upgrade to Pro before you hit it (or shorten retention to 14 days).
- **Adjust retention** if storage is a concern — change `RETENTION_DAYS` in `scripts/sync-cardkingdom.ts` and redeploy.

### Common gotchas

- **"401 Unauthorized" on the Refresh button** → PAT expired or wrong scope (needs Actions: read+write on this repo specifically).
- **Sync takes >10 min consistently** → Supabase is throttling. Reduce `PRICES_CHUNK` from 1000 to 500, or upgrade Supabase Pro.
- **Pruning is slow** → `card_prices` count grew past Postgres's comfortable delete-with-where range. Convert to a partitioned table by `captured_at` daily; drop the oldest partition instead of `delete`.
- **List page shows "Error: ..."** → migration not applied, or RLS policy missing. Re-run `0001_init.sql` (it's idempotent).
