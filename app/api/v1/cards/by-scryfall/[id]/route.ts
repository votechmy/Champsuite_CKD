import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { withCors, preflight } from '@/lib/cors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/v1/cards/by-scryfall/:id
 *
 * Returns ALL CK printings that map to this Scryfall UUID — typically 1 or 2
 * (one nonfoil row + optionally one foil row). Champ Suite chooses the right
 * one based on its inventory's `finish` value.
 *
 * Response shape:
 * {
 *   scryfall_id: "...",
 *   prints: [
 *     {
 *       finish: "nonfoil" | "foil",
 *       ck_id: 10000,
 *       sku: "4ED-117",
 *       name: "Abomination",
 *       edition: "4th Edition",
 *       variation: "",
 *       ck_url: "https://www.cardkingdom.com/mtg/4th-edition/abomination",
 *       scryfall_url: "https://scryfall.com/card/<uuid>",
 *       price: { retail: 0.35, buy: 0.01 },
 *       qty:   { retail: 25,   buying: 10 },
 *       conditions: {
 *         nm: { price: 0.35, qty: 0 },
 *         ex: { price: 0.28, qty: 10 },
 *         vg: { price: 0.25, qty: 15 },
 *         g:  { price: 0.18, qty: 0 }
 *       },
 *       captured_at: "2026-05-01T12:00:00.000Z"
 *     }
 *   ]
 * }
 *
 * Errors:
 *   400 — id isn't a valid UUID
 *   404 — no CK printing matches this scryfall_id
 *   500 — database error
 */
export async function OPTIONS() {
  return preflight();
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return withCors({ error: 'Invalid scryfall_id (expected UUID)' }, { status: 400 });
  }

  const supa = getSupabaseAdmin();
  const { data, error } = await supa
    .from('cards')
    .select(
      `id, sku, scryfall_id, url_slug, name, variation, edition, is_foil,
       card_prices_latest!inner (
         price_retail, qty_retail, price_buy, qty_buying,
         nm_price, nm_qty, ex_price, ex_qty,
         vg_price, vg_qty, g_price, g_qty,
         captured_at
       )`,
    )
    .eq('scryfall_id', id);

  if (error) {
    return withCors({ error: error.message }, { status: 500 });
  }
  if (!data || data.length === 0) {
    return withCors({ error: 'Not found', scryfall_id: id }, { status: 404 });
  }

  const prints = data.map((row) => {
    const latest = Array.isArray(row.card_prices_latest)
      ? row.card_prices_latest[0]
      : (row.card_prices_latest as Record<string, unknown> | null);
    const num = (v: unknown) => (v == null ? null : Number(v));
    const int = (v: unknown) => (v == null ? null : Number(v));
    return {
      finish: row.is_foil ? 'foil' : 'nonfoil',
      ck_id: row.id,
      sku: row.sku,
      name: row.name,
      edition: row.edition,
      variation: row.variation || null,
      ck_url: row.url_slug ? `https://www.cardkingdom.com/${row.url_slug}` : null,
      scryfall_url: `https://scryfall.com/card/${row.scryfall_id}`,
      price: {
        retail: num(latest?.price_retail),
        buy: num(latest?.price_buy),
      },
      qty: {
        retail: int(latest?.qty_retail),
        buying: int(latest?.qty_buying),
      },
      conditions: {
        nm: { price: num(latest?.nm_price), qty: int(latest?.nm_qty) },
        ex: { price: num(latest?.ex_price), qty: int(latest?.ex_qty) },
        vg: { price: num(latest?.vg_price), qty: int(latest?.vg_qty) },
        g: { price: num(latest?.g_price), qty: int(latest?.g_qty) },
      },
      captured_at: latest?.captured_at as string | null,
    };
  });

  return withCors({ scryfall_id: id, prints });
}
