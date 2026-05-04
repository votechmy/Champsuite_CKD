/**
 * POST /api/admin/upload-riftbound-inventory
 *
 * Accepts a TSV file from the magic-sorter scanner. Parses, validates,
 * upserts into riftbound_inventory by uuid, and records the run in
 * riftbound_uploads.
 *
 * Auth: shared-secret in `Authorization: Bearer <UPLOAD_TOKEN>` header.
 * Set UPLOAD_TOKEN in Vercel env vars. If unset, the endpoint refuses
 * everything (fail closed, not open).
 *
 * Expected TSV columns (tab-separated, header row required):
 *   set, rarity, lang, title, local_title, collector_num, condition,
 *   foil, position, height, price, price_trend, ecommerce_id,
 *   scryfall_id, uuid, confidence
 *
 * Example body: send the raw file as multipart/form-data with field name "file",
 * or paste the TSV body directly as text/plain.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function authOk(req: NextRequest): boolean {
  const expected = process.env.UPLOAD_TOKEN;
  if (!expected) return false; // fail closed if not configured
  const got = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  return got === expected;
}

function toInt(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toNum(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toBool(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'foil';
}

function toJson(v: string | undefined): unknown {
  if (!v) return null;
  try {
    return JSON.parse(v);
  } catch {
    return { raw: v };
  }
}

type ParsedRow = {
  uuid: string;
  set_id: string;
  collector_num: number;
  title: string | null;
  local_title: string | null;
  scanner_rarity: string | null;
  lang: string | null;
  condition: string | null;
  is_foil: boolean;
  position_in_tray: number | null;
  height: number | null;
  price: number | null;
  price_trend: number | null;
  ecommerce_id: number | null;
  scanner_code: string | null;
  confidence: unknown;
};

type ParseResult = {
  rows: ParsedRow[];
  failed: number;
  errors: string[];
};

/**
 * Split a single delimited line, respecting double-quoted cells (CSV-style
 * quoting: a cell may be wrapped in "..." and contain the delimiter; "" is
 * an escaped quote inside a quoted cell). Works for both ',' and '\t'.
 */
function splitDelimitedLine(line: string, delim: ',' | '\t'): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        cur += c;
      }
    } else {
      if (c === '"' && cur === '') {
        inQuote = true;
      } else if (c === delim) {
        out.push(cur);
        cur = '';
      } else {
        cur += c;
      }
    }
  }
  out.push(cur);
  return out;
}

function parseTsv(text: string): ParseResult {
  // Strip BOM and normalize line endings.
  const clean = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = clean.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length < 2) return { rows: [], failed: 0, errors: ['empty file or header only'] };

  // Auto-detect delimiter: tab if present, else comma. Scanner exports vary.
  const delim: ',' | '\t' = lines[0].includes('\t') ? '\t' : ',';

  const header = splitDelimitedLine(lines[0], delim).map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);

  const colSet = idx('set');
  const colRarity = idx('rarity');
  const colLang = idx('lang');
  const colTitle = idx('title');
  const colLocalTitle = idx('local_title');
  const colCollector = idx('collector_num');
  const colCondition = idx('condition');
  const colFoil = idx('foil');
  const colPosition = idx('position');
  const colHeight = idx('height');
  const colPrice = idx('price');
  const colTrend = idx('price_trend');
  const colEcom = idx('ecommerce_id');
  const colScryfall = idx('scryfall_id');
  const colUuid = idx('uuid');
  const colConfidence = idx('confidence');

  if (colSet < 0 || colCollector < 0 || colUuid < 0) {
    return {
      rows: [],
      failed: 0,
      errors: [`missing required columns. Need set, collector_num, uuid. Got: ${header.join(', ')}`],
    };
  }

  const rows: ParsedRow[] = [];
  const errors: string[] = [];
  let failed = 0;

  for (let i = 1; i < lines.length; i++) {
    const cells = splitDelimitedLine(lines[i], delim);
    const uuid = cells[colUuid]?.trim();
    const set_id = cells[colSet]?.trim()?.toUpperCase();
    const collector_num = toInt(cells[colCollector]);

    if (!uuid || !UUID_RE.test(uuid)) {
      failed++;
      if (errors.length < 5) errors.push(`row ${i + 1}: invalid uuid "${uuid ?? ''}"`);
      continue;
    }
    if (!set_id) {
      failed++;
      if (errors.length < 5) errors.push(`row ${i + 1}: missing set`);
      continue;
    }
    if (collector_num == null) {
      failed++;
      if (errors.length < 5) errors.push(`row ${i + 1}: invalid collector_num`);
      continue;
    }

    rows.push({
      uuid,
      set_id,
      collector_num,
      title: cells[colTitle]?.trim() || null,
      local_title: cells[colLocalTitle]?.trim() || null,
      scanner_rarity: cells[colRarity]?.trim() || null,
      lang: cells[colLang]?.trim() || null,
      condition: cells[colCondition]?.trim() || null,
      is_foil: toBool(cells[colFoil]),
      position_in_tray: toInt(cells[colPosition]),
      height: toInt(cells[colHeight]),
      price: toNum(cells[colPrice]),
      price_trend: toNum(cells[colTrend]),
      ecommerce_id: toInt(cells[colEcom]),
      scanner_code: cells[colScryfall]?.trim() || null,
      confidence: toJson(cells[colConfidence]),
    });
  }

  return { rows, failed, errors };
}

async function readBodyText(req: NextRequest): Promise<{ text: string; filename: string | null }> {
  const ct = req.headers.get('content-type') ?? '';
  if (ct.includes('multipart/form-data')) {
    const form = await req.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') throw new Error('no "file" field in form-data');
    const text = await file.text();
    return { text, filename: (file as File).name ?? null };
  }
  // Treat anything else as plain TSV body.
  const text = await req.text();
  return { text, filename: req.headers.get('x-filename') };
}

export async function POST(req: NextRequest) {
  if (!authOk(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let text: string;
  let filename: string | null;
  try {
    const body = await readBodyText(req);
    text = body.text;
    filename = body.filename;
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'bad body' }, { status: 400 });
  }

  const triggeredBy = req.headers.get('x-uploaded-by') ?? 'api';
  const { rows, failed, errors } = parseTsv(text);
  const supa = getSupabaseAdmin();

  // Open audit row.
  const { data: uploadRow, error: openErr } = await supa
    .from('riftbound_uploads')
    .insert({
      source: 'scanner-tsv',
      filename,
      triggered_by: triggeredBy,
      rows_parsed: rows.length + failed,
    })
    .select('id')
    .single();
  if (openErr || !uploadRow) {
    return NextResponse.json({ error: `audit insert failed: ${openErr?.message}` }, { status: 500 });
  }
  const batchId = uploadRow.id;

  if (rows.length === 0) {
    await supa
      .from('riftbound_uploads')
      .update({
        rows_upserted: 0,
        rows_failed: failed,
        error: errors.join('; ').slice(0, 2000) || 'no valid rows parsed',
      })
      .eq('id', batchId);
    return NextResponse.json(
      { batchId, parsed: 0, upserted: 0, failed, errors },
      { status: 400 },
    );
  }

  const now = new Date().toISOString();
  const dbRows = rows.map((r) => ({
    ...r,
    last_uploaded_at: now,
    upload_batch_id: batchId,
  }));

  // Chunk to keep request bodies sane.
  let upserted = 0;
  const CHUNK = 500;
  for (let i = 0; i < dbRows.length; i += CHUNK) {
    const batch = dbRows.slice(i, i + CHUNK);
    const { error } = await supa
      .from('riftbound_inventory')
      .upsert(batch, { onConflict: 'uuid' });
    if (error) {
      await supa
        .from('riftbound_uploads')
        .update({
          rows_upserted: upserted,
          rows_failed: failed + (rows.length - upserted),
          error: error.message.slice(0, 2000),
        })
        .eq('id', batchId);
      return NextResponse.json(
        { batchId, parsed: rows.length, upserted, failed, error: error.message },
        { status: 500 },
      );
    }
    upserted += batch.length;
  }

  await supa
    .from('riftbound_uploads')
    .update({ rows_upserted: upserted, rows_failed: failed })
    .eq('id', batchId);

  return NextResponse.json({
    batchId,
    parsed: rows.length,
    upserted,
    failed,
    errors: errors.length > 0 ? errors : undefined,
  });
}
