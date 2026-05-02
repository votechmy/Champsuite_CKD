import Link from 'next/link';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

type SearchParams = {
  q?: string;
  finish?: 'nonfoil' | 'foil' | 'etched' | '';
  page?: string;
};

type CardRow = {
  id: number;
  name: string;
  edition: string | null;
  variation: string | null;
  is_foil: boolean;
};

type LatestCk = {
  card_id: number;
  price_retail: number | null;
  price_buy: number | null;
};

type IdentRow = {
  mtgjson_uuid: string;
  finish: string;
  cardkingdom_id: number;
};

type MtgPrice = {
  mtgjson_uuid: string;
  provider: string;
  finish: string;
  kind: string;
  currency: string;
  price: number;
};

function fmtUSD(n: number | null | undefined): string {
  if (n == null) return '—';
  return `$${Number(n).toFixed(2)}`;
}
function fmtEUR(n: number | null | undefined): string {
  if (n == null) return '—';
  return `€${Number(n).toFixed(2)}`;
}

function spreadPct(a: number | null | undefined, base: number | null | undefined): { pct: number; dir: 'up' | 'down' | 'flat' } | null {
  if (a == null || base == null || base === 0) return null;
  const pct = ((a - base) / base) * 100;
  if (Math.abs(pct) < 1) return { pct, dir: 'flat' };
  return { pct, dir: pct > 0 ? 'up' : 'down' };
}

export default async function ComparePage(props: { searchParams: Promise<SearchParams> }) {
  const sp = await props.searchParams;
  const q = (sp.q ?? '').trim();
  const finish = sp.finish ?? '';
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const supa = getSupabaseAdmin();

  // 1. Filter cards (CK universe).
  let cardsQ = supa
    .from('cards')
    .select('id, name, edition, variation, is_foil', { count: 'exact' })
    .order('name', { ascending: true });
  if (q) cardsQ = cardsQ.ilike('name', `%${q}%`);
  if (finish === 'foil') cardsQ = cardsQ.eq('is_foil', true);
  else if (finish === 'nonfoil') cardsQ = cardsQ.eq('is_foil', false);
  cardsQ = cardsQ.range(from, to);

  const { data: cards, error: cardsErr, count } = await cardsQ;
  if (cardsErr) {
    return (
      <div>
        <h1>Compare</h1>
        <p style={{ color: '#c00' }}>Error: {cardsErr.message}</p>
      </div>
    );
  }
  const cardRows: CardRow[] = cards ?? [];
  const cardIds = cardRows.map((c) => c.id);
  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));

  // 2. CK latest prices for these cards.
  const ckLatestMap = new Map<number, LatestCk>();
  if (cardIds.length > 0) {
    const { data: ckLatest } = await supa
      .from('card_prices_latest')
      .select('card_id, price_retail, price_buy')
      .in('card_id', cardIds);
    for (const r of ckLatest ?? []) ckLatestMap.set(r.card_id, r as LatestCk);
  }

  // 3. MTGJSON identifiers: cardkingdom_id -> mtgjson_uuid (per finish).
  const identByCk = new Map<number, IdentRow>();
  if (cardIds.length > 0) {
    const { data: idents } = await supa
      .from('mtgjson_identifiers')
      .select('mtgjson_uuid, finish, cardkingdom_id')
      .in('cardkingdom_id', cardIds);
    for (const r of idents ?? []) identByCk.set(r.cardkingdom_id, r as IdentRow);
  }

  // 4. MTGJSON latest prices for the matched uuids.
  const uuids = Array.from(new Set(Array.from(identByCk.values()).map((i) => i.mtgjson_uuid)));
  // priceMap: `${uuid}|${finish}|${provider}|${kind}` -> {price, currency}
  const mtgPriceMap = new Map<string, { price: number; currency: string }>();
  if (uuids.length > 0) {
    const { data: prices } = await supa
      .from('mtgjson_prices_latest')
      .select('mtgjson_uuid, provider, finish, kind, currency, price')
      .in('mtgjson_uuid', uuids);
    for (const r of (prices ?? []) as MtgPrice[]) {
      mtgPriceMap.set(`${r.mtgjson_uuid}|${r.finish}|${r.provider}|${r.kind}`, {
        price: Number(r.price),
        currency: r.currency,
      });
    }
  }

  // 5. Sync freshness summary.
  const [{ data: ckRun }, { data: mjRun }] = await Promise.all([
    supa
      .from('sync_runs')
      .select('started_at, status')
      .eq('status', 'success')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supa
      .from('mtgjson_sync_runs')
      .select('started_at, status, uuids_matched_ck')
      .eq('status', 'success')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const fmtAgo = (iso: string | null | undefined) => {
    if (!iso) return '—';
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  };

  return (
    <div>
      <h1>Compare prices across sources</h1>
      <p className="muted">
        Card Kingdom (direct, fresh) + MTGJSON daily snapshot (TCGplayer, Cardmarket, Cardsphere, CK-via-MTGJSON for cross-check). 3-day history.
      </p>

      <div className="summary-grid">
        <div className="summary-card">
          <div className="summary-label">Last CK sync</div>
          <div className="summary-value">{fmtAgo(ckRun?.started_at)}</div>
        </div>
        <div className="summary-card">
          <div className="summary-label">Last MTGJSON sync</div>
          <div className="summary-value">{fmtAgo(mjRun?.started_at)}</div>
        </div>
        <div className="summary-card">
          <div className="summary-label">CK cards w/ MTGJSON match</div>
          <div className="summary-value">{(mjRun?.uuids_matched_ck ?? 0).toLocaleString()}</div>
        </div>
      </div>

      <form className="toolbar" method="get">
        <input type="text" name="q" placeholder="Search by card name…" defaultValue={q} />
        <select name="finish" defaultValue={finish}>
          <option value="">Both finishes</option>
          <option value="nonfoil">Nonfoil only</option>
          <option value="foil">Foil only</option>
        </select>
        <button type="submit">Search</button>
        <span className="spacer" />
        <Link href="/list" className="muted" style={{ fontSize: 13 }}>
          ← back to pricelist
        </Link>
      </form>

      <p className="muted" style={{ marginBottom: 8 }}>
        {(count ?? 0).toLocaleString()} matches · page {page} of {totalPages}
      </p>

      <table className="cards">
        <thead>
          <tr>
            <th>Card</th>
            <th>Edition</th>
            <th>Finish</th>
            <th className="num">CK retail</th>
            <th className="num">CK buy</th>
            <th className="num">TCG market</th>
            <th className="num">TCG low</th>
            <th className="num">Cardmarket</th>
            <th className="num">Spread</th>
          </tr>
        </thead>
        <tbody>
          {cardRows.map((card) => {
            const finishKey = card.is_foil ? 'foil' : 'nonfoil';
            const ck = ckLatestMap.get(card.id);
            const ident = identByCk.get(card.id);

            const tcgMarket = ident
              ? mtgPriceMap.get(`${ident.mtgjson_uuid}|${finishKey}|tcgplayer|retail`)
              : undefined;
            const tcgBuy = ident
              ? mtgPriceMap.get(`${ident.mtgjson_uuid}|${finishKey}|tcgplayer|buylist`)
              : undefined;
            const mkm = ident
              ? mtgPriceMap.get(`${ident.mtgjson_uuid}|${finishKey}|cardmarket|retail`)
              : undefined;

            const sp = spreadPct(tcgMarket?.price ?? null, ck?.price_retail != null ? Number(ck.price_retail) : null);

            return (
              <tr key={card.id}>
                <td>
                  <Link href={`/compare/${card.id}`}>{card.name}</Link>
                  {card.variation ? <span className="muted"> · {card.variation}</span> : null}
                </td>
                <td>{card.edition ?? '—'}</td>
                <td>
                  <span className="muted">{finishKey}</span>
                </td>
                <td className="num">{fmtUSD(ck?.price_retail != null ? Number(ck.price_retail) : null)}</td>
                <td className="num">{fmtUSD(ck?.price_buy != null ? Number(ck.price_buy) : null)}</td>
                <td className="num">{fmtUSD(tcgMarket?.price ?? null)}</td>
                <td className="num">{fmtUSD(tcgBuy?.price ?? null)}</td>
                <td className="num">{fmtEUR(mkm?.price ?? null)}</td>
                <td className="num">
                  {sp ? (
                    <span
                      style={{
                        color: sp.dir === 'up' ? '#c00' : sp.dir === 'down' ? '#0a7d27' : '#888',
                        fontWeight: 600,
                      }}
                    >
                      {sp.pct > 0 ? '+' : ''}
                      {sp.pct.toFixed(1)}%
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            );
          })}
          {cardRows.length === 0 ? (
            <tr>
              <td colSpan={9} style={{ padding: 32, textAlign: 'center' }} className="muted">
                No matches.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <Pagination page={page} totalPages={totalPages} q={q} finish={finish} />
    </div>
  );
}

function Pagination({
  page,
  totalPages,
  q,
  finish,
}: {
  page: number;
  totalPages: number;
  q: string;
  finish: string;
}) {
  const buildHref = (p: number) => {
    const sp = new URLSearchParams();
    if (q) sp.set('q', q);
    if (finish) sp.set('finish', finish);
    sp.set('page', String(p));
    return `/compare?${sp.toString()}`;
  };
  return (
    <div className="pagination">
      {page > 1 ? <a href={buildHref(page - 1)}>← Prev</a> : <span className="disabled">← Prev</span>}
      <span className="muted">
        Page {page} / {totalPages}
      </span>
      {page < totalPages ? <a href={buildHref(page + 1)}>Next →</a> : <span className="disabled">Next →</span>}
    </div>
  );
}
