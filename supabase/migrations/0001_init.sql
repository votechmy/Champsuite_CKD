-- ChampSuite CKD: Card Kingdom pricelist mirror
-- Pulled from https://api.cardkingdom.com/api/v2/pricelist
-- Each row in payload.data has: id, sku, scryfall_id, url, name, variation,
-- edition, is_foil, price_retail, qty_retail, price_buy, qty_buying,
-- condition_values { nm_price, nm_qty, ex_price, ex_qty, vg_price, vg_qty, g_price, g_qty }

create table if not exists cards (
  id              bigint primary key,            -- CK's stable integer id
  sku             text not null,
  scryfall_id     uuid,
  url_slug        text,
  name            text not null,
  variation       text,
  edition         text,
  is_foil         boolean not null default false,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now()
);

create index if not exists cards_name_idx on cards using gin (to_tsvector('simple', name));
create index if not exists cards_name_trgm_idx on cards (lower(name));
create index if not exists cards_edition_idx on cards (edition);
create index if not exists cards_sku_idx on cards (sku);

-- Time-series snapshot. Append-only with 30d retention.
create table if not exists card_prices (
  card_id        bigint references cards(id) on delete cascade,
  captured_at    timestamptz not null,
  price_retail   numeric(10,2),
  qty_retail     integer,
  price_buy      numeric(10,2),
  qty_buying     integer,
  -- Per-condition breakdown (NM/EX/VG/G)
  nm_price       numeric(10,2),
  nm_qty         integer,
  ex_price       numeric(10,2),
  ex_qty         integer,
  vg_price       numeric(10,2),
  vg_qty         integer,
  g_price        numeric(10,2),
  g_qty          integer,
  primary key (card_id, captured_at)
);

create index if not exists card_prices_captured_at_idx on card_prices (captured_at desc);
create index if not exists card_prices_card_recent_idx on card_prices (card_id, captured_at desc);

-- Latest snapshot per card. Powers the list view efficiently.
create or replace view card_prices_latest as
select distinct on (card_id)
  card_id,
  captured_at,
  price_retail,
  qty_retail,
  price_buy,
  qty_buying,
  nm_price, nm_qty, ex_price, ex_qty, vg_price, vg_qty, g_price, g_qty
from card_prices
order by card_id, captured_at desc;

-- Sync run audit. UI shows "last synced N min ago" and surfaces failures.
create table if not exists sync_runs (
  id             bigserial primary key,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  rows_in_dump   integer,
  cards_upserted integer,
  prices_inserted integer,
  prices_pruned  integer,
  status         text not null default 'running',  -- running | success | failure
  error          text,
  triggered_by   text                              -- 'cron' | 'manual:<user>' | 'cli'
);

create index if not exists sync_runs_started_at_idx on sync_runs (started_at desc);

-- RLS: deny by default. Anon/authed users get read-only on cards + prices via policies.
-- The sync worker uses the service_role key which bypasses RLS.
alter table cards         enable row level security;
alter table card_prices   enable row level security;
alter table sync_runs     enable row level security;

create policy "read cards (authed)"        on cards         for select using (auth.role() = 'authenticated');
create policy "read prices (authed)"       on card_prices   for select using (auth.role() = 'authenticated');
create policy "read sync_runs (authed)"    on sync_runs     for select using (auth.role() = 'authenticated');
