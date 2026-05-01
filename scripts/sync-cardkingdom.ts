/**
 * sync-cardkingdom.ts
 *
 * Pulls the Card Kingdom pricelist dump, upserts identity rows into `cards`,
 * appends a snapshot row per card into `card_prices`, prunes prices older
 * than 30 days, and records the run in `sync_runs`.
 *
 * Runs in two contexts:
 *   - GitHub Actions cron (daily 08:00 UTC)
 *   - GitHub Actions workflow_dispatch from the /api/refresh route
 *   - Local CLI: pnpm sync
 */

import { getSupabaseAdmin } from '../lib/supabase/admin';

type CkRow = {
  id: number;
  sku: string;
  scryfall_id: string | null;
  url: string;
  name: string;
  variation: string;
  edition: string;
  is_foil: 'true' | 'false' | boolean;
  price_retail: string | number;
  qty_retail: number;
  price_buy: string | number;
  qty_buying: number;
  condition_values?: {
    nm_price?: string | number;
    nm_qty?: number;
    ex_price?: string | number;
    ex_qty?: number;
    vg_price?: string | number;
    vg_qty?: number;
    g_price?: string | number;
    g_qty?: number;
  };
};

const CK_URL = process.env.CK_PRICELIST_URL ?? 'https://api.cardkingdom.com/api/v2/pricelist';
const CARDS_CHUNK = 500;
const PRICES_CHUNK = 1000;
const RETENTION_DAYS = 30;

function toNumber(v: string | number | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

function toBool(v: string | boolean | undefined): boolean {
  if (typeof v === 'boolean') return v;
  return v === 'true' || v === '1';
}

function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  const triggeredBy = process.env.SYNC_TRIGGERED_BY ?? 'cli';
  const supa = getSupabaseAdmin();
  const capturedAt = new Date().toISOString();

  // 1. Open run row.
  const { data: runRow, error: runErr } = await supa
    .from('sync_runs')
    .insert({ triggered_by: triggeredBy, status: 'running' })
    .select('id')
    .single();
  if (runErr || !runRow) throw new Error(`Failed to open sync_run: ${runErr?.message}`);
  const runId: number = runRow.id;
  console.log(`[sync] run #${runId} started (trigger=${triggeredBy})`);

  let cardsUpserted = 0;
  let pricesInserted = 0;
  let prunedCount = 0;
  let rowsInDump = 0;

  try {
    // 2. Fetch the dump. ~65MB; default fetch buffers it. Node heap handles fine.
    console.log(`[sync] fetching ${CK_URL} ...`);
    const res = await fetch(CK_URL, { headers: { 'user-agent': 'champsuite-ckd-sync/1.0' } });
    if (!res.ok) throw new Error(`CK returned HTTP ${res.status}`);
    const payload = (await res.json()) as { meta?: unknown; data?: CkRow[] };
    const rows = payload.data ?? [];
    rowsInDump = rows.length;
    console.log(`[sync] fetched ${rowsInDump.toLocaleString()} rows`);

    // 3. Upsert identity into `cards`.
    const cards = rows.map((r) => ({
      id: r.id,
      sku: r.sku,
      scryfall_id: r.scryfall_id || null,
      url_slug: r.url,
      name: r.name,
      variation: r.variation || null,
      edition: r.edition || null,
      is_foil: toBool(r.is_foil),
      last_seen_at: capturedAt,
    }));

    for (const batch of chunked(cards, CARDS_CHUNK)) {
      const { error } = await supa
        .from('cards')
        .upsert(batch, { onConflict: 'id', ignoreDuplicates: false });
      if (error) throw new Error(`cards upsert failed: ${error.message}`);
      cardsUpserted += batch.length;
      if (cardsUpserted % 10000 < CARDS_CHUNK) {
        console.log(`[sync] cards upserted: ${cardsUpserted.toLocaleString()}/${rowsInDump.toLocaleString()}`);
      }
    }
    console.log(`[sync] cards upsert done: ${cardsUpserted.toLocaleString()}`);

    // 4. Insert price snapshot rows. Use upsert(onConflict id+captured_at) so
    //    re-runs within the same second are idempotent.
    const prices = rows.map((r) => ({
      card_id: r.id,
      captured_at: capturedAt,
      price_retail: toNumber(r.price_retail),
      qty_retail: r.qty_retail ?? null,
      price_buy: toNumber(r.price_buy),
      qty_buying: r.qty_buying ?? null,
      nm_price: toNumber(r.condition_values?.nm_price),
      nm_qty: r.condition_values?.nm_qty ?? null,
      ex_price: toNumber(r.condition_values?.ex_price),
      ex_qty: r.condition_values?.ex_qty ?? null,
      vg_price: toNumber(r.condition_values?.vg_price),
      vg_qty: r.condition_values?.vg_qty ?? null,
      g_price: toNumber(r.condition_values?.g_price),
      g_qty: r.condition_values?.g_qty ?? null,
    }));

    for (const batch of chunked(prices, PRICES_CHUNK)) {
      const { error } = await supa
        .from('card_prices')
        .upsert(batch, { onConflict: 'card_id,captured_at' });
      if (error) throw new Error(`card_prices insert failed: ${error.message}`);
      pricesInserted += batch.length;
      if (pricesInserted % 20000 < PRICES_CHUNK) {
        console.log(`[sync] prices inserted: ${pricesInserted.toLocaleString()}/${rowsInDump.toLocaleString()}`);
      }
    }
    console.log(`[sync] prices insert done: ${pricesInserted.toLocaleString()}`);

    // 5. Prune anything older than retention window. Only on success.
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { error: pruneErr, count } = await supa
      .from('card_prices')
      .delete({ count: 'exact' })
      .lt('captured_at', cutoff);
    if (pruneErr) throw new Error(`prune failed: ${pruneErr.message}`);
    prunedCount = count ?? 0;
    console.log(`[sync] pruned ${prunedCount.toLocaleString()} rows older than ${cutoff}`);

    // 6. Close run row.
    await supa
      .from('sync_runs')
      .update({
        finished_at: new Date().toISOString(),
        rows_in_dump: rowsInDump,
        cards_upserted: cardsUpserted,
        prices_inserted: pricesInserted,
        prices_pruned: prunedCount,
        status: 'success',
      })
      .eq('id', runId);

    console.log(`[sync] run #${runId} success`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[sync] run #${runId} FAILED: ${message}`);
    await supa
      .from('sync_runs')
      .update({
        finished_at: new Date().toISOString(),
        rows_in_dump: rowsInDump,
        cards_upserted: cardsUpserted,
        prices_inserted: pricesInserted,
        prices_pruned: prunedCount,
        status: 'failure',
        error: message.slice(0, 2000),
      })
      .eq('id', runId);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
