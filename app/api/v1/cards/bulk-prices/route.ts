import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { withCors, preflight } from '@/lib/cors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 500;

/**
 * POST /api/v1/cards/bulk-prices
 *
 * Hot-path endpoint: take a list of Scryfall UUIDs (e.g. from Champ Suite's
 * inventory) and return current CK prices for each. Returns ALL printings per
 * scryfall_id (foil + nonfoil if both exist) — caller filters by `finish`.
 *
 * Request body:
 *   {
 *     "scryfall_ids": ["uuid1", "uuid2", ...],   // max 500
 *     "finish": "nonfoil" | "foil" | null         // optional filter
 *   }
 *
 * Response:
 *   {
 *     "captured_at_max": "2026-05-01T12:00:00.000Z",
 *     "found": 487,
 *     "missing": ["uuid3", "uuid17", ...],     // scryfall_ids with no CK row
 *     "results": [
 *       {
 *         "scryfall_id": "...",
 *         "finish": "nonfoil",
 *         "ck_id": 10000,
 *         "sku": "4ED-117",
 *         "price_retail": 0.35,
 *         "price_buy": 0.01,
 *         "qty_retail": 25,
 *         "qty_buying": 10,
 *         "captured_at": "2026-05-01T12:00:00.000Z"
 *       },
 *       ...
 *     ]
 *   }
 *
 * Errors:
 *   400 — body shape wrong, too many ids, or all ids invalid UUIDs
 */
export async function OPTIONS() {
  return preflight();
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return withCors({ error: 'Body must be JSON' }, { status: 400 });
  }

  const ids = Array.isArray((body as { scryfall_ids?: unknown })?.scryfall_ids)
    ? ((body as { scryfall_ids: unknown[] }).scryfall_ids as unknown[])
    : null;
  const finish = (body as { finish?: unknown })?.finish;

  if (!ids) {
    return withCors({ error: 'scryfall_ids must be an array of UUID strings' }, { status: 400 });
  }
  if (ids.length === 0) {
    return withCors({ captured_at_max: null, found: 0, missing: [], results: [] });
  }
  if (ids.length > MAX_IDS) {
    return withCors(
      { error: `Too many ids (${ids.length}). Max ${MAX_IDS} per request.` },
      { status: 400 },
    );
  }

  const validIds = ids.filter((x): x is string => typeof x === 'string' && UUID_RE.test(x));
  if (validIds.length === 0) {
    return withCors({ error: 'No valid UUIDs in scryfall_ids' }, { status: 400 });
  }

  let finishFilter: boolean | null = null;
  if (finish === 'foil') finishFilter = true;
  else if (finish === 'nonfoil') finishFilter = false;
  else if (finish != null && finish !== '' && finish !== 'any') {
    return withCors(
      { error: "finish must be 'nonfoil', 'foil', 'any', or omitted" },
      { status: 400 },
    );
  }

  const supa = getSupabaseAdmin();
  let q = supa
    .from('cards')
    .select(
      `id, sku, scryfall_id, is_foil,
       card_prices_latest!inner (
         price_retail, qty_retail, price_buy, qty_buying, captured_at
       )`,
    )
    .in('scryfall_id', validIds);
  if (finishFilter !== null) q = q.eq('is_foil', finishFilter);

  const { data, error } = await q;
  if (error) {
    return withCors({ error: error.message }, { status: 500 });
  }

  const num = (v: unknown) => (v == null ? null : Number(v));
  const int = (v: unknown) => (v == null ? null : Number(v));

  const seen = new Set<string>();
  let capturedMax: string | null = null;
  const results = (data ?? []).map((row) => {
    const latest = Array.isArray(row.card_prices_latest)
      ? row.card_prices_latest[0]
      : (row.card_prices_latest as Record<string, unknown> | null);
    const captured = (latest?.captured_at as string | null) ?? null;
    if (captured && (!capturedMax || captured > capturedMax)) capturedMax = captured;
    if (row.scryfall_id) seen.add(row.scryfall_id);
    return {
      scryfall_id: row.scryfall_id,
      finish: row.is_foil ? 'foil' : 'nonfoil',
      ck_id: row.id,
      sku: row.sku,
      price_retail: num(latest?.price_retail),
      price_buy: num(latest?.price_buy),
      qty_retail: int(latest?.qty_retail),
      qty_buying: int(latest?.qty_buying),
      captured_at: captured,
    };
  });

  const missing = validIds.filter((id) => !seen.has(id));

  return withCors({
    captured_at_max: capturedMax,
    found: results.length,
    missing,
    results,
  });
}
