-- ChampSuite CKD: MTGJSON multi-source price mirror
-- Pulled daily from https://mtgjson.com/api/v5/AllPricesToday.json.gz
-- Identifier mappings from https://mtgjson.com/api/v5/AllIdentifiers.json.gz
--
-- Strategy: filter to CK universe only (rows whose cardKingdomId/Foil/Etched
-- matches an existing cards.id). 3-day price retention to stay under
-- Supabase free tier 500MB.
--
-- A single mtgjson_uuid identifies a printing; ck has separate ids per finish
-- (nonfoil/foil/etched), so the identifier table is denormalized to one row
-- per (uuid, finish).

create table if not exists mtgjson_identifiers (
  mtgjson_uuid     uuid not null,
  finish           text not null,         -- 'nonfoil' | 'foil' | 'etched'
  cardkingdom_id   bigint,                -- joins to cards.id
  tcgplayer_id     bigint,
  mcm_id           bigint,
  scryfall_id      uuid,
  name             text,
  set_code         text,
  last_seen_at     timestamptz not null default now(),
  primary key (mtgjson_uuid, finish)
);

create index if not exists mtgjson_ident_ck_idx
  on mtgjson_identifiers (cardkingdom_id)
  where cardkingdom_id is not null;

create index if not exists mtgjson_ident_scry_idx
  on mtgjson_identifiers (scryfall_id)
  where scryfall_id is not null;

-- Append-only price snapshot table. captured_on is a DATE (not timestamptz)
-- so re-running the sync on the same day is idempotent without millisecond
-- collisions, and 3 days = at most 3 rows per (uuid, provider, finish, kind).
create table if not exists mtgjson_prices (
  mtgjson_uuid    uuid not null,
  provider        text not null,         -- 'cardkingdom' | 'tcgplayer' | 'cardmarket' | 'cardsphere'
  finish          text not null,         -- 'nonfoil' | 'foil' | 'etched'
  kind            text not null,         -- 'retail' | 'buylist'
  currency        text not null,         -- 'USD' | 'EUR'
  captured_on     date not null,
  price           numeric(12,4) not null,
  primary key (mtgjson_uuid, provider, finish, kind, captured_on)
);

create index if not exists mtgjson_prices_captured_idx
  on mtgjson_prices (captured_on desc);

create index if not exists mtgjson_prices_lookup_idx
  on mtgjson_prices (mtgjson_uuid, provider, finish, kind, captured_on desc);

-- Latest snapshot per (uuid, provider, finish, kind) for fast list queries.
create or replace view mtgjson_prices_latest as
select distinct on (mtgjson_uuid, provider, finish, kind)
  mtgjson_uuid, provider, finish, kind, currency, captured_on, price
from mtgjson_prices
order by mtgjson_uuid, provider, finish, kind, captured_on desc;

-- Sync run audit (mirrors sync_runs shape).
create table if not exists mtgjson_sync_runs (
  id                    bigserial primary key,
  started_at            timestamptz not null default now(),
  finished_at           timestamptz,
  status                text not null default 'running',  -- running | success | failure
  uuids_in_dump         integer,
  uuids_matched_ck      integer,
  identifiers_upserted  integer,
  prices_upserted       integer,
  prices_pruned         integer,
  error                 text,
  triggered_by          text
);

create index if not exists mtgjson_sync_runs_started_at_idx
  on mtgjson_sync_runs (started_at desc);

-- RLS: same shape as existing tables. Service role bypasses; authed users read.
alter table mtgjson_identifiers enable row level security;
alter table mtgjson_prices      enable row level security;
alter table mtgjson_sync_runs   enable row level security;

create policy "read mtgjson_identifiers (authed)"
  on mtgjson_identifiers for select using (auth.role() = 'authenticated');

create policy "read mtgjson_prices (authed)"
  on mtgjson_prices for select using (auth.role() = 'authenticated');

create policy "read mtgjson_sync_runs (authed)"
  on mtgjson_sync_runs for select using (auth.role() = 'authenticated');
