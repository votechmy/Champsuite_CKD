/**
 * sync-riftbound.ts
 *
 * Pulls Riftbound (Riot's TCG) catalog from Riftcodex — a community-run
 * Scryfall-equivalent — and mirrors it into Supabase. Catalog only:
 * names, sets, art, identifiers (incl. tcgplayer_id for future pricing).
 *
 * Why Riftcodex over Riot's official API:
 *   - Riot's dev key returns 403 on the Riftbound content endpoint
 *   - Riot's production-key path requires a public-facing user product;
 *     internal commercial tools (POS, inventory) don't fit any approved bucket
 *   - Riftcodex is unauthenticated, fast, has tcgplayer_id on every card
 *     (so pricing via TCGplayer later is a clean join)
 *
 * Update cadence: weekly. Riftbound releases new sets every few months —
 * polling daily would be wasteful.
 *
 * Runs in two contexts:
 *   - GitHub Actions cron (weekly, Mondays 22:00 UTC)
 *   - Local CLI: npm run sync:riftbound
 */

import { getSupabaseAdmin } from '../lib/supabase/admin';

const API_BASE = process.env.RIFTCODEX_BASE_URL ?? 'https://api.riftcodex.com';
const PAGE_SIZE = 100;
const CARDS_CHUNK = 200;

type RiftcodexSet = {
  id: string;
  name: string;
  set_id: string;
  card_count?: number;
  tcgplayer_id?: number | string | null;
  cardmarket_id?: string | string[] | null;
  published_on?: string | null;
};

type RiftcodexCard = {
  id: string;
  name: string;
  riftbound_id?: string;
  tcgplayer_id?: number | string | null;
  collector_number?: number;
  public_code?: string;
  attributes?: { energy?: number; might?: number; power?: number };
  classification?: {
    type?: string;
    supertype?: string | null;
    rarity?: string;
    domain?: string[];
  };
  text?: { plain?: string; rich?: string; flavour?: string };
  set?: { set_id?: string; label?: string };
  media?: { image_url?: string; artist?: string; accessibility_text?: string };
  tags?: string[];
  orientation?: string;
  metadata?: Record<string, unknown>;
};

type Page<T> = { items: T[]; total: number; page: number; size: number; pages: number };

function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function toBigint(v: number | string | null | undefined): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

function joinCardmarketId(v: string | string[] | null | undefined): string | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v.length === 0 ? null : v.join(',');
  return v || null;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'champsuite-ckd-riftbound/1.0', accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function fetchAllSets(): Promise<RiftcodexSet[]> {
  // Sets are small enough that one page covers them all (currently 7).
  const page = await fetchJson<Page<RiftcodexSet>>(`${API_BASE}/sets?page=1&size=100`);
  return page.items;
}

async function fetchAllCards(): Promise<RiftcodexCard[]> {
  const all: RiftcodexCard[] = [];
  let pageNum = 1;
  let totalPages = 1;
  do {
    const page = await fetchJson<Page<RiftcodexCard>>(
      `${API_BASE}/cards?page=${pageNum}&size=${PAGE_SIZE}`,
    );
    all.push(...page.items);
    totalPages = page.pages;
    if (pageNum === 1 || pageNum % 5 === 0 || pageNum === totalPages) {
      console.log(`[riftbound] fetched page ${pageNum}/${totalPages} — ${all.length}/${page.total} cards`);
    }
    pageNum++;
  } while (pageNum <= totalPages);
  return all;
}

async function main() {
  const triggeredBy = process.env.SYNC_TRIGGERED_BY ?? 'cli';
  const supa = getSupabaseAdmin();
  const capturedAt = new Date().toISOString();

  const { data: runRow, error: runErr } = await supa
    .from('riftbound_sync_runs')
    .insert({ triggered_by: triggeredBy, status: 'running' })
    .select('id')
    .single();
  if (runErr || !runRow) throw new Error(`Failed to open riftbound_sync_run: ${runErr?.message}`);
  const runId: number = runRow.id;
  console.log(`[riftbound] run #${runId} started (trigger=${triggeredBy})`);

  let setsUpserted = 0;
  let cardsUpserted = 0;
  let cardsInDump = 0;

  try {
    // 1. Sets first — cards FK them.
    console.log(`[riftbound] fetching sets ...`);
    const sets = await fetchAllSets();
    console.log(`[riftbound] ${sets.length} sets fetched`);

    const setRows = sets.map((s) => ({
      set_id: s.set_id,
      name: s.name,
      card_count: s.card_count ?? null,
      tcgplayer_id: toBigint(s.tcgplayer_id),
      cardmarket_id: joinCardmarketId(s.cardmarket_id),
      published_on: s.published_on ?? null,
      last_seen_at: capturedAt,
    }));

    const { error: setErr } = await supa
      .from('riftbound_sets')
      .upsert(setRows, { onConflict: 'set_id' });
    if (setErr) throw new Error(`sets upsert failed: ${setErr.message}`);
    setsUpserted = setRows.length;

    // 2. Cards.
    console.log(`[riftbound] fetching cards ...`);
    const cards = await fetchAllCards();
    cardsInDump = cards.length;
    console.log(`[riftbound] ${cardsInDump} cards fetched`);

    const cardRows = cards.map((c) => ({
      id: c.id,
      riftbound_id: c.riftbound_id ?? null,
      name: c.name,
      set_id: c.set?.set_id ?? null,
      collector_number: c.collector_number ?? null,
      public_code: c.public_code ?? null,
      tcgplayer_id: toBigint(c.tcgplayer_id),
      type: c.classification?.type ?? null,
      supertype: c.classification?.supertype ?? null,
      rarity: c.classification?.rarity ?? null,
      domain: c.classification?.domain ?? null,
      energy: c.attributes?.energy ?? null,
      might: c.attributes?.might ?? null,
      power: c.attributes?.power ?? null,
      text_plain: c.text?.plain ?? null,
      text_flavour: c.text?.flavour ?? null,
      image_url: c.media?.image_url ?? null,
      artist: c.media?.artist ?? null,
      tags: c.tags ?? null,
      orientation: c.orientation ?? null,
      metadata: c.metadata ?? null,
      last_seen_at: capturedAt,
    }));

    for (const batch of chunked(cardRows, CARDS_CHUNK)) {
      const { error } = await supa
        .from('riftbound_cards')
        .upsert(batch, { onConflict: 'id' });
      if (error) throw new Error(`cards upsert failed: ${error.message}`);
      cardsUpserted += batch.length;
    }
    console.log(`[riftbound] cards upsert done: ${cardsUpserted}`);

    await supa
      .from('riftbound_sync_runs')
      .update({
        finished_at: new Date().toISOString(),
        cards_in_dump: cardsInDump,
        cards_upserted: cardsUpserted,
        sets_upserted: setsUpserted,
        status: 'success',
      })
      .eq('id', runId);
    console.log(`[riftbound] run #${runId} success`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[riftbound] run #${runId} FAILED: ${message}`);
    await supa
      .from('riftbound_sync_runs')
      .update({
        finished_at: new Date().toISOString(),
        cards_in_dump: cardsInDump,
        cards_upserted: cardsUpserted,
        sets_upserted: setsUpserted,
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
