/**
 * sync-mtgjson.ts
 *
 * Pulls MTGJSON's cardIdentifiers (CSV, ~15MB gz) + AllPricesToday (JSON, ~5MB gz),
 * filters to the Card Kingdom universe (only cards already in our `cards` table),
 * upserts identifier mappings + today's prices, prunes >3d, records the run.
 *
 * Why CSV for identifiers (not AllIdentifiers.json):
 *   AllIdentifiers.json.gz decompresses to >512MB, past Node's max string length.
 *   The streaming-JSON workaround was brittle (subpath imports, factory-API guesses).
 *   The CSV variant has the exact same id mappings, parses line by line with zero
 *   dependencies via Node's built-in readline.
 *
 * Why bulk JSON for prices:
 *   AllPricesToday.json.gz is ~50MB raw — well under the 512MB limit. JSON.parse
 *   handles it fine in one pass.
 *
 * Decisions:
 *   - 3-day retention (RETENTION_DAYS=3) keeps storage <150MB on top of CK.
 *   - Skip MTGO (cardhoarder) — paper-only tool.
 *   - Cardkingdom prices via MTGJSON kept as a cross-check ("CK via MTGJSON")
 *     even though we have CK direct — useful for spotting MTGJSON ingest lag.
 */

import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';
import { gunzipSync } from 'node:zlib';
import { getSupabaseAdmin } from '../lib/supabase/admin';

const PRICES_URL = process.env.MTGJSON_PRICES_URL ?? 'https://mtgjson.com/api/v5/AllPricesToday.json.gz';
const IDENTIFIERS_URL = process.env.MTGJSON_IDENTIFIERS_URL ?? 'https://mtgjson.com/api/v5/csv/cardIdentifiers.csv.gz';
const RETENTION_DAYS = 3;
const IDENT_CHUNK = 1000;
const PRICES_CHUNK = 1000;

const PAPER_PROVIDERS = ['cardkingdom', 'tcgplayer', 'cardmarket', 'cardsphere'] as const;
type PaperProvider = (typeof PAPER_PROVIDERS)[number];

const FINISH_MAP: Record<string, 'nonfoil' | 'foil' | 'etched'> = {
  normal: 'nonfoil',
  foil: 'foil',
  etched: 'etched',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function toUuid(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  return UUID_RE.test(v) ? v : null;
}

function toInt(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

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
  captured_on: string;
  price: number;
};

async function loadCkUniverse(supa: ReturnType<typeof getSupabaseAdmin>): Promise<Set<number>> {
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

/**
 * Stream-fetch the gzipped CSV, pipe through gunzip, then readline.
 * Each line is a CSV row; first line is the header.
 *
 * The CSV is ~110k rows, ~30MB raw — small enough to hold all identifier rows
 * in memory after filtering (typically ~50–80k matches).
 */
async function streamIdentifiersCsv(
  url: string,
  ckSet: Set<number>,
  capturedAt: string,
): Promise<{ rows: IdentifierRow[]; uuidsInDump: number; matchedUuids: Set<string> }> {
  console.log(`[mtgjson] streaming cardIdentifiers.csv (${url}) ...`);
  const t0 = Date.now();
  const res = await fetch(url, { headers: { 'user-agent': 'champsuite-ckd-mtgjson/1.0' } });
  if (!res.ok) throw new Error(`cardIdentifiers HTTP ${res.status}`);
  if (!res.body) throw new Error('cardIdentifiers response had no body');

  const nodeStream = Readable.fromWeb(res.body as unknown as Parameters<typeof Readable.fromWeb>[0]);
  const gunzip = createGunzip();
  nodeStream.pipe(gunzip);

  const rl = createInterface({ input: gunzip, crlfDelay: Infinity });

  const rows: IdentifierRow[] = [];
  const matchedUuids = new Set<string>();
  let uuidsInDump = 0;
  let header: string[] | null = null;
  let colIdx: Record<string, number> = {};

  for await (const line of rl) {
    if (!line) continue;
    const cells = line.split(',');
    if (!header) {
      header = cells;
      colIdx = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
      // Sanity: confirm the columns we need exist.
      const need = ['uuid', 'cardKingdomId', 'cardKingdomFoilId', 'cardKingdomEtchedId', 'tcgplayerProductId', 'tcgplayerEtchedProductId', 'mcmId', 'scryfallId'];
      for (const k of need) {
        if (!(k in colIdx)) throw new Error(`cardIdentifiers.csv missing column: ${k}`);
      }
      continue;
    }

    uuidsInDump++;
    const uuid = toUuid(cells[colIdx.uuid]);
    if (!uuid) continue;

    const ckNonfoil = toInt(cells[colIdx.cardKingdomId]);
    const ckFoil = toInt(cells[colIdx.cardKingdomFoilId]);
    const ckEtched = toInt(cells[colIdx.cardKingdomEtchedId]);
    if (ckNonfoil == null && ckFoil == null && ckEtched == null) continue;

    const tcgRegular = toInt(cells[colIdx.tcgplayerProductId]);
    const tcgEtched = toInt(cells[colIdx.tcgplayerEtchedProductId]);
    const mcm = toInt(cells[colIdx.mcmId]);
    const scry = toUuid(cells[colIdx.scryfallId]);

    const candidates: Array<['nonfoil' | 'foil' | 'etched', number | null, number | null]> = [
      ['nonfoil', ckNonfoil, tcgRegular],
      ['foil', ckFoil, tcgRegular],
      ['etched', ckEtched, tcgEtched ?? tcgRegular],
    ];

    for (const [finish, ckId, tcgId] of candidates) {
      if (ckId == null || !ckSet.has(ckId)) continue;
      matchedUuids.add(uuid);
      rows.push({
        mtgjson_uuid: uuid,
        finish,
        cardkingdom_id: ckId,
        tcgplayer_id: tcgId,
        mcm_id: mcm,
        scryfall_id: scry,
        name: null,        // CSV doesn't carry name/setCode; cards table covers it via join
        set_code: null,
        last_seen_at: capturedAt,
      });
    }

    if (uuidsInDump % 25000 === 0) {
      console.log(`[mtgjson]   walked ${uuidsInDump.toLocaleString()} rows, matched ${matchedUuids.size.toLocaleString()} so far`);
    }
  }

  console.log(
    `[mtgjson] cardIdentifiers parsed in ${Date.now() - t0}ms: ${uuidsInDump.toLocaleString()} rows, ${matchedUuids.size.toLocaleString()} matched, ${rows.length.toLocaleString()} identifier rows after per-finish denorm`,
  );
  return { rows, uuidsInDump, matchedUuids };
}

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

async function fetchPricesJsonGz(url: string): Promise<PricesFile> {
  console.log(`[mtgjson] fetching AllPricesToday (${url}) ...`);
  const t0 = Date.now();
  const res = await fetch(url, { headers: { 'user-agent': 'champsuite-ckd-mtgjson/1.0' } });
  if (!res.ok) throw new Error(`AllPricesToday HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const decompressed = gunzipSync(buf);
  const json = JSON.parse(decompressed.toString('utf-8')) as PricesFile;
  console.log(
    `[mtgjson] AllPricesToday parsed: ${buf.length.toLocaleString()}B gz / ${decompressed.length.toLocaleString()}B raw in ${
      Date.now() - t0
    }ms`,
  );
  return json;
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
              captured_on: date,
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
    console.log(`[mtgjson] loading CK universe from cards table ...`);
    const ckSet = await loadCkUniverse(supa);
    console.log(`[mtgjson] CK universe size: ${ckSet.size.toLocaleString()} ids`);
    if (ckSet.size === 0) {
      throw new Error('cards table is empty — run sync-cardkingdom first');
    }

    const { rows: identRows, uuidsInDump: idDump, matchedUuids } = await streamIdentifiersCsv(
      IDENTIFIERS_URL,
      ckSet,
      capturedAt,
    );
    uuidsInDump = idDump;
    uuidsMatched = matchedUuids.size;

    for (const batch of chunked(identRows, IDENT_CHUNK)) {
      const { error } = await supa
        .from('mtgjson_identifiers')
        .upsert(batch, { onConflict: 'mtgjson_uuid,finish' });
      if (error) throw new Error(`identifiers upsert failed: ${error.message}`);
      identifiersUpserted += batch.length;
    }
    console.log(`[mtgjson] identifiers upsert done: ${identifiersUpserted.toLocaleString()}`);

    const prices = await fetchPricesJsonGz(PRICES_URL);
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

    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { error: pruneErr, count } = await supa
      .from('mtgjson_prices')
      .delete({ count: 'exact' })
      .lt('captured_on', cutoff);
    if (pruneErr) throw new Error(`prune failed: ${pruneErr.message}`);
    prunedCount = count ?? 0;
    console.log(`[mtgjson] pruned ${prunedCount.toLocaleString()} rows older than ${cutoff}`);

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
