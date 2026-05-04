-- ⚠️ Run in Supabase Studio → SQL Editor when storage is over the 500MB cap.
-- Trims CK price history to 1 day (matches updated RETENTION_DAYS=1) and
-- compacts the table so the freed space is actually reclaimed to the
-- filesystem (not just marked reusable).
--
-- Safe to re-run. Wrapped in a transaction for the DELETE; the VACUUM runs
-- outside the transaction (Postgres requirement).

BEGIN;

-- Drop everything in card_prices older than 24h. The next sync run will
-- re-populate today's snapshot fresh, so we lose nothing the cron can't
-- restore.
DELETE FROM card_prices
WHERE captured_at < (now() - interval '1 day');

-- Same for MTGJSON if it's also bloating. Comment this out if you want
-- to keep the full 3-day MTGJSON window.
-- DELETE FROM mtgjson_prices
-- WHERE captured_on < (current_date - interval '1 day');

COMMIT;

-- Compact card_prices to actually return the freed pages to the OS.
-- VACUUM FULL takes an exclusive lock briefly; on a few-million-row table
-- it's seconds, not minutes. After this, Supabase storage should drop.
VACUUM FULL card_prices;
-- VACUUM FULL mtgjson_prices;  -- uncomment if you also pruned MTGJSON

-- Sanity check counts after the trim.
SELECT
  (SELECT COUNT(*) FROM card_prices)    AS ck_price_rows,
  (SELECT COUNT(*) FROM mtgjson_prices) AS mj_price_rows,
  (SELECT MIN(captured_at) FROM card_prices)  AS ck_oldest,
  (SELECT MAX(captured_at) FROM card_prices)  AS ck_newest;
