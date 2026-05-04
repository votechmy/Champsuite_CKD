-- ChampSuite CKD: Riftbound inventory (scanner-uploaded TSV from the magic sorter).
-- One row per physically scanned card. The scanner outputs columns:
--   set, rarity, lang, title, local_title, collector_num, condition, foil,
--   position, height, price, price_trend, ecommerce_id, scryfall_id, uuid, confidence
--
-- Join to catalog: riftbound_inventory.set_id + collector_num →
-- riftbound_cards.set_id + collector_number. The scanner's `scryfall_id`
-- column holds a positional code (e.g. "13-SFD-63"), not a real Scryfall UUID.

create table if not exists riftbound_inventory (
  uuid              uuid primary key,           -- scanner-assigned, also Champ Suite inventory id
  set_id            text not null,              -- 'SFD'
  collector_num     integer not null,           -- 63
  -- scanner snapshot (denormalized; catalog truth is in riftbound_cards via the join)
  title             text,
  local_title       text,
  scanner_rarity    text,
  lang              text,
  condition         text,                       -- 'NM' | 'EX' | 'VG' | 'G' | 'LP' | etc.
  is_foil           boolean not null default false,
  position_in_tray  integer,                    -- physical slot from sorter
  height            integer,                    -- scanner metric
  -- pricing as captured at scan time
  price             numeric(10,2),              -- our selling price
  price_trend       numeric(10,2),              -- TCG market reference at scan
  ecommerce_id      bigint,                     -- our Shopify/store catalog id
  scanner_code      text,                       -- '13-SFD-63'
  confidence        jsonb,                      -- {"art": 1} or richer JSON
  -- bookkeeping
  first_uploaded_at timestamptz not null default now(),
  last_uploaded_at  timestamptz not null default now(),
  upload_batch_id   bigint                      -- references riftbound_uploads.id
);

create index if not exists riftbound_inv_setnum_idx
  on riftbound_inventory (set_id, collector_num);
create index if not exists riftbound_inv_uploaded_idx
  on riftbound_inventory (last_uploaded_at desc);
create index if not exists riftbound_inv_condition_idx
  on riftbound_inventory (condition);

-- Audit table for each upload run.
create table if not exists riftbound_uploads (
  id              bigserial primary key,
  uploaded_at     timestamptz not null default now(),
  source          text,                       -- 'scanner-tsv' | 'manual' | etc.
  filename        text,
  rows_parsed     integer,
  rows_upserted   integer,
  rows_failed     integer,
  error           text,
  triggered_by    text                        -- email if known, else 'api'
);

create index if not exists riftbound_uploads_at_idx
  on riftbound_uploads (uploaded_at desc);

-- RLS — same pattern as MTG/Riftbound catalog tables.
alter table riftbound_inventory enable row level security;
alter table riftbound_uploads   enable row level security;

create policy "read riftbound_inventory (authed)"
  on riftbound_inventory for select using (auth.role() = 'authenticated');

create policy "read riftbound_uploads (authed)"
  on riftbound_uploads for select using (auth.role() = 'authenticated');
