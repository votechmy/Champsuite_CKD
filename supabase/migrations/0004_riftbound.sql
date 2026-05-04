-- ChampSuite CKD: Riftbound (Riot's TCG) catalog mirror via Riftcodex.
-- Source: https://api.riftcodex.com (community Scryfall-equivalent, no auth)
-- ~1,064 cards across 7 sets at time of first sync. Updated as new sets release.
--
-- This is catalog only — names, sets, art, identifiers. Pricing comes later
-- via TCGplayer using the cross-ref tcgplayer_id on each card.
--
-- Schema is parallel to (not joined with) the MTG tables. Riftbound and MTG
-- are different games, different identifiers, different price feeds.

create table if not exists riftbound_sets (
  set_id          text primary key,           -- 'OGN', 'UNL'
  name            text not null,
  card_count      integer,
  tcgplayer_id    bigint,
  cardmarket_id   text,                       -- can be null, single, or comma-joined per Riftcodex
  published_on    date,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now()
);

create table if not exists riftbound_cards (
  id                text primary key,         -- Riftcodex's stable id (UUID-ish hex)
  riftbound_id      text,                     -- e.g. 'ogn-179-298' (Riot's id)
  name              text not null,
  set_id            text references riftbound_sets(set_id) on delete cascade,
  collector_number  integer,
  public_code       text,                     -- e.g. 'OGN-179/298'
  tcgplayer_id      bigint,                   -- bridge to TCGplayer pricing
  type              text,
  supertype         text,
  rarity            text,
  domain            text[],                   -- ['Chaos'], ['Calm', 'Order']
  energy            integer,
  might             integer,
  power             integer,
  text_plain        text,
  text_flavour      text,
  image_url         text,
  artist            text,
  tags              text[],
  orientation       text,
  metadata          jsonb,                    -- catch-all: alternate_art, signature, overnumbered, etc.
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now()
);

create index if not exists riftbound_cards_tcg_idx on riftbound_cards (tcgplayer_id) where tcgplayer_id is not null;
create index if not exists riftbound_cards_name_idx on riftbound_cards (lower(name));
create index if not exists riftbound_cards_set_idx on riftbound_cards (set_id);
create index if not exists riftbound_cards_rarity_idx on riftbound_cards (rarity);

create table if not exists riftbound_sync_runs (
  id              bigserial primary key,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  status          text not null default 'running',  -- running | success | failure
  cards_in_dump   integer,
  cards_upserted  integer,
  sets_upserted   integer,
  error           text,
  triggered_by    text
);

create index if not exists riftbound_sync_runs_started_at_idx on riftbound_sync_runs (started_at desc);

-- RLS — same pattern as the MTG tables.
alter table riftbound_sets       enable row level security;
alter table riftbound_cards      enable row level security;
alter table riftbound_sync_runs  enable row level security;

create policy "read riftbound_sets (authed)"
  on riftbound_sets for select using (auth.role() = 'authenticated');

create policy "read riftbound_cards (authed)"
  on riftbound_cards for select using (auth.role() = 'authenticated');

create policy "read riftbound_sync_runs (authed)"
  on riftbound_sync_runs for select using (auth.role() = 'authenticated');
