-- ⚠️ Run in Supabase Studio → SQL Editor as TWO SEPARATE QUERIES.
-- Supabase wraps each editor run in a transaction by default, and VACUUM
-- cannot run inside a transaction block. So: paste section 1, run, clear,
-- paste section 2, run.
--
-- Trims both CK and MTGJSON price history to 1 day to fit under Supabase's
-- 500 MB free tier. Compare page only ever needs today's snapshot anyway.

-- =========== SECTION 1 — paste and run, then clear the editor ===========

DELETE FROM card_prices
WHERE captured_at < (now() - interval '1 day');

DELETE FROM mtgjson_prices
WHERE captured_on < (current_date - interval '1 day');

-- =========== SECTION 2 — paste and run as a separate query =============
-- VACUUM FULL takes an exclusive lock briefly; on a few-million-row table
-- it's seconds, not minutes. After this, Supabase storage drops.

VACUUM FULL card_prices;
VACUUM FULL mtgjson_prices;

-- =========== SECTION 3 — optional sanity check ========================

SELECT
  (SELECT COUNT(*) FROM card_prices)    AS ck_price_rows,
  (SELECT COUNT(*) FROM mtgjson_prices) AS mj_price_rows,
  (SELECT MIN(captured_at) FROM card_prices)  AS ck_oldest,
  (SELECT MAX(captured_at) FROM card_prices)  AS ck_newest,
  (SELECT MIN(captured_on) FROM mtgjson_prices) AS mj_oldest,
  (SELECT MAX(captured_on) FROM mtgjson_prices) AS mj_newest;
