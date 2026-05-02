/**
 * sync-mtgjson.ts
 *
 * Pulls MTGJSON's AllIdentifiers + AllPricesToday, filters to the Card Kingdom
 * universe (only cards already in our `cards` table), upserts identifier
 * mappings + today's prices, prunes >3d, records the run.
 *
 * Decisions:
 *   - .json.gz over .json.xz so Node's built-in zlib handles decompression
 *     (no native deps, runs identically on Windows / Linux / GH runner).
 *   - 3-day retention (RETENTION_DAYS=3) keeps storage <150MB on top of CK.
 *   - Skip MTGO (cardhoarder) — paper-only tool.
 *   - Cardkingdom prices via MTGJSON are kept as a cross-check ("CK via MTGJSON")
 *     even though we have CK direct — useful for spotting MTGJSON ingest lag.
 *
 * Runs in two contexts:
 *   - GitHub Actions cron (daily 21:30 UTC = 5:30am MYT, 30 min after CK sync)
 *   - GitHub Actions workflow_dispatch
 *   - Local CLI: npm run sync:mtgjson
 */

import { gunzipSync } from 'node:zlib';
import { getSupabaseAdmin } from '../lib/supabase/admin';

const PRICES_URL = process.env.MTGJSON_PRICES_URL ?? 'https://mtgjson.com/api/v5/AllPricesToday.json.gz';
const IDENTIFIERS_URL = process.env.MTGJSON_IDENTIFIERS_URL ?? 'https://mtgjson.com/api/v5/AllIdentifiers.json.gz';
const RETENTION_DAYS = 3;
const IDENT_CHUNK = 1000;
const PRICES_CHUNK = 1000;

// Providers we care about. cardhoarder = MTGO tix, skip.
const PAPER_PROVIDERS = ['cardkingdom', 'tcgplayer', 'cardmarket', 'cardsphere'] as const;
type PaperProvider = (typeof PAPER_PROVIDERS)[number];

const PROVIDER_CURRENCY: Record<PaperProvider, 'USD' | 'EUR'> = {
  cardkingdom: 'USD',
  tcgplayer: 'USD',
  cardmarket: 'EUR',
  cardsphere: 'USD',
};

// MTGJSON finish keys -> our normalized finish names.
const FINISH_MAP: Record<string, 'nonfoil' | 'foil' | 'etched'> = {
  normal: 'nonfoil',
  foil: 'foil',
  etched: 'etched',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function toUuid(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return UUID_RE.test(v) ? v : null;
}

function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchJsonGz<T>(url: string, label: string): Promise<T> {
  console.log(`[mtgjson] fetching ${label} (${url}) ...`);
  const t0 = Date.now();
  const res = await fetch(url, { headers: { 'user-agent': 'champsuite-ckd-mtgjson/1.0' } });
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const gzBytes = buf.length;
  const decompressed = gunzipSync(buf);
  const json = JSON.parse(decompressed.toString('utf-8')) as T;
  console.log(
    `[mtgjson] ${label} fetched: ${gzBytes.toLocaleString()}B gz / ${decompressed.length.toLocaleString()}B raw in ${
      Date.now() - t0
    }ms`,
  );
  return json;
}

type IdentifiersFile = {
  data: Record<
    string,
    {
      cardKingdomId?: string;
      cardKingdomFoilId?: string;
      cardKingdomEtchedId?: string;
      tcgplayerProductId?: string;
      tcgplayerEtchedProductId?: string;
      mcmId?: string;
      scryfallId?: string;
      name?: string;
      setCode?: string;
    }
  >;
};

type PriceFormats = {
  paper?: Partial<
    Record<
      PaperProvider,
      {
        currency?: string;
        retail?: { normal?: Record<string, number>; foil?: Record<string, number>; etched?: Record<string, number> };
        buylist?: { normal?: Record<string, number>; foil?: Record<string, number>; etched?: Record<string, number> };
      }
    >
  >;
};

type PricesFile = {
  data: Record<string, PriceFormats>;
};

type IdentifierRow = {
  mtgjson_uuid: string;
  finish: 'nonfoil' | 'foil' | 'etched';
  cardkingdom_id: number;
  tcgplayer_id: number | null;
  mcm_id: number | null;
  scryfall_id: string | null;
  name: string | null;
  set_code: string | null;
  last_seen_at: string;
};

type PriceRow = {
  mtgjson_uuid: string;
  provider: PaperProvider;
  finish: 'nonfoil' | 'foil' | 'etched';
  kind: 'retail' | 'buylist';
  currency: 'USD' | 'EUR';
  captured_on: string; // YYYY-MM-DD
  price: number;
};

async function loadCkUniverse(supa: ReturnType<typeof getSupabaseAdmin>): Promise<Set<number>> {
  // Page through cards.id (could be 150k+). Supabase caps at 1000/page by default.
  const PAGE = 1000;
  const out = new Set<number>();
  let from = 0;
  while (true) {
    const { data, error } = await supa.from('cards').select('id').range(from, from + PAGE - 1);
    if (error) throw new Error(`loadCkUniverse: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) out.add(Number(r.id));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

function buildIdentifierRows(file: IdentifiersFile, ckSet: Set<number>, capturedAt: string) {
  const rows: IdentifierRow[] = [];
  let uuidsInDump = 0;
  const matchedUuids = new Set<string>();

  for (const [rawUuid, ids] of Object.entries(file.data)) {
    uuidsInDump++;
    const uuid = toUuid(rawUuid);
    if (!uuid) continue;

    const tcgplayer = ids.tcgplayerProductId ? Number(ids.tcgplayerProductId) : null;
    const tcgEtched = ids.tcgplayerEtchedProductId ? Number(ids.tcgplayerEtchedProductId) : null;
    const mcm = ids.mcmId ? Number(ids.mcmId) : null;
    const scry = toUuid(ids.scryfallId);
    const name = ids.name ?? null;
    const setCode = ids.setCode ?? null;

    const candidates: Array<['nonfoil' | 'foil' | 'etched', number, number | null]> = [];
    if (ids.cardKingdomId) candidates.push(['nonfoil', Number(ids.cardKingdomId), tcgplayer]);
    if (ids.cardKingdomFoilId) candidates.push(['foil', Number(ids.cardKingdomFoilId), tcgplayer]);
    if (ids.cardKingdomEtchedId) candidates.push(['etched', Number(ids.cardKingdomEtchedId), tcgEtched ?? tcgplayer]);

    for (const [finish, ckId, tcgId] of candidates) {
      if (!Number.isFinite(ckId) || !ckSet.has(ckId)) continue;
      matchedUuids.add(uuid);
      rows.push({
        mtgjson_uuid: uuid,
        finish,
        cardkingdom_id: ckId,
        tcgplayer_id: Number.isFinite(tcgId) ? tcgId : null,
        mcm_id: Number.isFinite(mcm) ? mcm : null,
        scryfall_id: scry,
        name,
        set_code: setCode,
        last_seen_at: capturedAt,
      });
    }
  }

  return { rows, uuidsInDump, matchedUuids };
}

function buildPriceRows(file: PricesFile, matchedUuids: Set<string>): PriceRow[] {
  const rows: PriceRow[] = [];
  for (const [rawUuid, formats] of Object.entries(file.data)) {
    const uuid = toUuid(rawUuid);
    if (!uuid || !matchedUuids.has(uuid) || !formats.paper) continue;

    for (const provider of PAPER_PROVIDERS) {
      const block = formats.paper[provider];
      if (!block) continue;
      const currency = (block.currency?.toUpperCase() === 'EUR' ? 'EUR' : 'USD') as 'USD' | 'EUR';

      for (const kind of ['retail', 'buylist'] as const) {
        const finishes = block[kind];
        if (!finishes) continue;

        for (const [mtgjsonFinish, dateMap] of Object.entries(finishes)) {
          const finish = FINISH_MAP[mtgjsonFinish];
          if (!finish || !dateMap) continue;

          for (const [date, price] of Object.entries(dateMap)) {
            if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) continue;
            rows.push({
              mtgjson_uuid: uuid,
              provider,
              finish,
              kind,
              currency,
              captured_on: date, // mtgjson dates are YYYY-MM-DD already
              price,
            });
          }
        }
      }
    }
  }
  return rows;
}

async function main() {
  const triggeredBy = process.env.SYNC_TRIGGERED_BY ?? 'cli';
  const supa = getSupabaseAdmin();
  const capturedAt = new Date().toISOString();

  const { data: runRow, error: runErr } = await supa
    .from('mtgjson_sync_runs')
    .insert({ triggered_by: triggeredBy, status: 'running' })
    .select('id')
    .single();
  if (runErr || !runRow) throw new Error(`Failed to open mtgjson_sync_run: ${runErr?.message}`);
  const runId: number = runRow.id;
  console.log(`[mtgjson] run #${runId} started (trigger=${triggeredBy})`);

  let uuidsInDump = 0;
  let uuidsMatched = 0;
  let identifiersUpserted = 0;
  let pricesUpserted = 0;
  let prunedCount = 0;

  try {
    // 1. Build CK universe set from `cards`.
    console.log(`[mtgjson] loading CK universe from cards table ...`);
    const ckSet = await loadCkUniverse(supa);
    console.log(`[mtgjson] CK universe size: ${ckSet.size.toLocaleString()} ids`);
    if (ckSet.size === 0) {
      throw new Error('cards table is empty — run sync-cardkingdom first');
    }

    // 2. Identifiers.
    const idents = await fetchJsonGz<IdentifiersFile>(IDENTIFIERS_URL, 'AllIdentifiers');
    const { rows: identRows, uuidsInDump: idDump, matchedUuids } = buildIdentifierRows(idents, ckSet, capturedAt);
    uuidsInDump = idDump;
    uuidsMatched = matchedUuids.size;
    console.log(
      `[mtgjson] identifiers: ${idDump.toLocaleString()} uuids in dump, ${uuidsMatched.toLocaleString()} match CK universe (${identRows.length.toLocaleString()} rows after per-finish denorm)`,
    );

    for (const batch of chunked(identRows, IDENT_CHUNK)) {
      const { error } = await supa
        .from('mtgjson_identifiers')
        .upsert(batch, { onConflict: 'mtgjson_uuid,finish' });
      if (error) throw new Error(`identifiers upsert failed: ${error.message}`);
      identifiersUpserted += batch.length;
    }
    console.log(`[mtgjson] identifiers upsert done: ${identifiersUpserted.toLocaleString()}`);

    // 3. Prices.
    const prices = await fetchJsonGz<PricesFile>(PRICES_URL, 'AllPricesToday');
    const priceRows = buildPriceRows(prices, matchedUuids);
    console.log(`[mtgjson] price rows to upsert: ${priceRows.length.toLocaleString()}`);

    for (const batch of chunked(priceRows, PRICES_CHUNK)) {
      const { error } = await supa
        .from('mtgjson_prices')
        .upsert(batch, { onConflict: 'mtgjson_uuid,provider,finish,kind,captured_on' });
      if (error) throw new Error(`prices upsert failed: ${error.message}`);
      pricesUpserted += batch.length;
      if (pricesUpserted % 50000 < PRICES_CHUNK) {
        console.log(`[mtgjson] prices upserted: ${pricesUpserted.toLocaleString()}/${priceRows.length.toLocaleString()}`);
      }
    }
    console.log(`[mtgjson] prices upsert done: ${pricesUpserted.toLocaleString()}`);

    // 4. Prune older than RETENTION_DAYS.
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { error: pruneErr, count } = await supa
      .from('mtgjson_prices')
      .delete({ count: 'exact' })
      .lt('captured_on', cutoff);
    if (pruneErr) throw new Error(`prune failed: ${pruneErr.message}`);
    prunedCount = count ?? 0;
    console.log(`[mtgjson] pruned ${prunedCount.toLocaleString()} rows older than ${cutoff}`);

    // 5. Close.
    await supa
      .from('mtgjson_sync_runs')
      .update({
        finished_at: new Date().toISOString(),
        uuids_in_dump: uuidsInDump,
        uuids_matched_ck: uuidsMatched,
        identifiers_upserted: identifiersUpserted,
        prices_upserted: pricesUpserted,
        prices_pruned: prunedCount,
        status: 'success',
      })
      .eq('id', runId);
    console.log(`[mtgjson] run #${runId} success`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[mtgjson] run #${runId} FAILED: ${message}`);
    await supa
      .from('mtgjson_sync_runs')
      .update({
        finished_at: new Date().toISOString(),
        uuids_in_dump: uuidsInDump,
        uuids_matched_ck: uuidsMatched,
        identifiers_upserted: identifiersUpserted,
        prices_upserted: pricesUpserted,
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
