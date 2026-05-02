-- Dashboard views: top movers + buylist arbitrage opportunities.
-- These are read-only views with no schema changes; safe to re-run.
--
-- card_movers_24h
--   Today's CK retail vs the most recent prior-day snapshot, ranked by
--   absolute % change. Filters: price_prev > $1 (skip noise on bulk),
--   and the price actually changed.
--
-- buylist_opportunities
--   Cards where CK's buylist price (what CK pays you) is above TCGplayer's
--   retail (what TCG charges). When that's true you can buy a copy on TCG
--   and flip it to CK's buylist for a positive spread. Limited to top 100.

create or replace view card_movers_24h as
with cap as (
  select max(captured_at::date) as today_d from card_prices
),
today as (
  select distinct on (card_id) card_id, price_retail, captured_at
  from card_prices, cap
  where captured_at::date = cap.today_d
  order by card_id, captured_at desc
),
prev as (
  select distinct on (card_id) card_id, price_retail, captured_at
  from card_prices, cap
  where captured_at::date < cap.today_d
  order by card_id, captured_at desc
)
select
  t.card_id,
  t.price_retail as price_today,
  p.price_retail as price_prev,
  (t.price_retail - p.price_retail) as delta,
  ((t.price_retail - p.price_retail) / nullif(p.price_retail, 0))::numeric(8,4) as pct_change,
  t.captured_at as today_at,
  p.captured_at as prev_at
from today t
join prev p using (card_id)
where t.price_retail is not null
  and p.price_retail is not null
  and p.price_retail > 1
  and t.price_retail <> p.price_retail
order by abs((t.price_retail - p.price_retail) / nullif(p.price_retail, 0)) desc
limit 100;

create or replace view buylist_opportunities as
select
  c.id as card_id,
  c.name,
  c.edition,
  c.is_foil,
  c.scryfall_id,
  ckp.price_buy as ck_buy,
  mtp.price as tcg_retail,
  (ckp.price_buy - mtp.price) as spread,
  ((ckp.price_buy - mtp.price) / nullif(mtp.price, 0))::numeric(8,4) as spread_pct
from cards c
join card_prices_latest ckp on ckp.card_id = c.id
join mtgjson_identifiers mi on mi.cardkingdom_id = c.id
  and mi.finish = case when c.is_foil then 'foil' else 'nonfoil' end
join mtgjson_prices_latest mtp on mtp.mtgjson_uuid = mi.mtgjson_uuid
  and mtp.finish = mi.finish
  and mtp.provider = 'tcgplayer'
  and mtp.kind = 'retail'
where ckp.price_buy is not null
  and mtp.price is not null
  and mtp.price > 0
  and ckp.price_buy > mtp.price
order by (ckp.price_buy - mtp.price) desc
limit 100;
