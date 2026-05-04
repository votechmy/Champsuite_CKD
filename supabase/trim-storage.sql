-- ⚠️ Run in Supabase Studio → SQL Editor as TWO SEPARATE QUERIES.
-- Supabase wraps each editor run in a transaction by default, and VACUUM
-- cannot run inside a transaction block. So: paste section 1, run, clear,
-- paste section 2, run.
--
-- Trims CK price history to 1 day (matches updated RETENTION_DAYS=1) and
-- compacts the table so the freed space is actually reclaimed to the
-- filesystem (not just marked reusable).

-- =========== SECTION 1 — paste and run, then clear the editor ===========

DELETE FROM card_prices
WHERE captured_at < (now() - interval '1 day');

-- Same for MTGJSON if it's also bloating. Uncomment if you want.
-- DELETE FROM mtgjson_prices
-- WHERE captured_on < (current_date - interval '1 day');

-- =========== SECTION 2 — paste and run as a separate query =============
-- VACUUM FULL takes an exclusive lock briefly; on a few-million-row table
-- it's seconds, not minutes. After this, Supabase storage should drop.

VACUUM FULL card_prices;
-- VACUUM FULL mtgjson_prices;  -- uncomment if you also pruned MTGJSON

-- =========== SECTION 3 — optional sanity check ========================

SELECT
  (SELECT COUNT(*) FROM card_prices)    AS ck_price_rows,
  (SELECT COUNT(*) FROM mtgjson_prices) AS mj_price_rows,
  (SELECT MIN(captured_at) FROM card_prices)  AS ck_oldest,
  (SELECT MAX(captured_at) FROM card_prices)  AS ck_newest;
