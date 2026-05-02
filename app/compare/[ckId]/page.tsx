import { Fragment } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

type Params = { ckId: string };

const PROVIDER_LABEL: Record<string, string> = {
  cardkingdom: 'CK via MTGJSON',
  tcgplayer: 'TCGplayer',
  cardmarket: 'Cardmarket',
  cardsphere: 'Cardsphere',
};

const PROVIDER_TAG_CLASS: Record<string, string> = {
  cardkingdom: 'src-ck',
  tcgplayer: 'src-tcg',
  cardmarket: 'src-mkm',
  cardsphere: 'src-csp',
};

function fmtPrice(price: number, currency: string): string {
  if (currency === 'EUR') return `€${price.toFixed(2)}`;
  return `$${price.toFixed(2)}`;
}

function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default async function CompareDetail(props: { params: Promise<Params> }) {
  const { ckId: ckIdStr } = await props.params;
  const ckId = Number(ckIdStr);
  if (!Number.isFinite(ckId)) notFound();

  const supa = getSupabaseAdmin();

  const { data: card, error: cardErr } = await supa
    .from('cards')
    .select('id, sku, scryfall_id, url_slug, name, variation, edition, is_foil')
    .eq('id', ckId)
    .maybeSingle();
  if (cardErr) throw new Error(cardErr.message);
  if (!card) notFound();

  const finishKey: 'nonfoil' | 'foil' = card.is_foil ? 'foil' : 'nonfoil';

  // CK direct prices (latest + 7d history)
  const [{ data: ckLatest }, { data: ckHistory }] = await Promise.all([
    supa
      .from('card_prices_latest')
      .select('captured_at, price_retail, qty_retail, price_buy, qty_buying')
      .eq('card_id', ckId)
      .maybeSingle(),
    supa
      .from('card_prices')
      .select('captured_at, price_retail, price_buy')
      .eq('card_id', ckId)
      .order('captured_at', { ascending: true }),
  ]);

  // MTGJSON identifier (for this finish).
  const { data: ident } = await supa
    .from('mtgjson_identifiers')
    .select('mtgjson_uuid, finish, tcgplayer_id, mcm_id, scryfall_id, name, set_code')
    .eq('cardkingdom_id', ckId)
    .eq('finish', finishKey)
    .maybeSingle();

  // MTGJSON prices (latest + 3d history) for this uuid+finish.
  let mjLatest:
    | Array<{ provider: string; kind: string; currency: string; captured_on: string; price: number }>
    | null = null;
  let mjHistory:
    | Array<{ provider: string; kind: string; captured_on: string; price: number; currency: string }>
    | null = null;
  if (ident) {
    const [latestRes, histRes] = await Promise.all([
      supa
        .from('mtgjson_prices_latest')
        .select('provider, kind, currency, captured_on, price')
        .eq('mtgjson_uuid', ident.mtgjson_uuid)
        .eq('finish', finishKey),
      supa
        .from('mtgjson_prices')
        .select('provider, kind, captured_on, price, currency')
        .eq('mtgjson_uuid', ident.mtgjson_uuid)
        .eq('finish', finishKey)
        .order('captured_on', { ascending: true }),
    ]);
    mjLatest = latestRes.data ?? null;
    mjHistory = histRes.data ?? null;
  }

  // Pick best retail / best buylist (in USD only — we don't FX-convert EUR yet).
  const usdRetailCandidates: Array<{ src: string; price: number }> = [];
  const usdBuyCandidates: Array<{ src: string; price: number }> = [];
  if (ckLatest?.price_retail != null) usdRetailCandidates.push({ src: 'CK direct', price: Number(ckLatest.price_retail) });
  if (ckLatest?.price_buy != null) usdBuyCandidates.push({ src: 'CK direct', price: Number(ckLatest.price_buy) });
  for (const r of mjLatest ?? []) {
    if (r.currency !== 'USD') continue;
    if (r.kind === 'retail') usdRetailCandidates.push({ src: PROVIDER_LABEL[r.provider] ?? r.provider, price: r.price });
    if (r.kind === 'buylist') usdBuyCandidates.push({ src: PROVIDER_LABEL[r.provider] ?? r.provider, price: r.price });
  }
  const bestBuy = usdRetailCandidates.length ? usdRetailCandidates.reduce((a, b) => (a.price < b.price ? a : b)) : null;
  const bestSell = usdBuyCandidates.length ? usdBuyCandidates.reduce((a, b) => (a.price > b.price ? a : b)) : null;

  return (
    <div>
      <p className="muted" style={{ marginBottom: 8 }}>
        <Link href="/compare">← back to compare</Link>
      </p>

      <div className="card-hero" style={{ display: 'flex', gap: 24, background: '#fff', border: '1px solid #e5e5e5', borderRadius: 8, padding: 20, marginBottom: 24 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: '0 0 6px', fontSize: 22 }}>{card.name}</h1>
          <div className="muted" style={{ marginBottom: 12 }}>
            {card.edition ?? 'Unknown edition'} · {finishKey}
            {card.variation ? ` · ${card.variation}` : ''}
          </div>
          <div style={{ fontSize: 12, color: '#888', fontFamily: 'ui-monospace, SFMono-Regular, monospace', lineHeight: 1.6 }}>
            <div>ck_id: <code>{card.id}</code></div>
            {card.sku ? <div>sku: <code>{card.sku}</code></div> : null}
            {card.scryfall_id ? <div>scryfall_id: <code>{card.scryfall_id}</code></div> : null}
            {ident ? (
              <>
                <div>mtgjson_uuid: <code>{ident.mtgjson_uuid}</code></div>
                {ident.tcgplayer_id ? <div>tcgplayer_id: <code>{ident.tcgplayer_id}</code></div> : null}
                {ident.mcm_id ? <div>mcm_id: <code>{ident.mcm_id}</code></div> : null}
              </>
            ) : (
              <div style={{ color: '#a06600' }}>no MTGJSON match for this CK id (foil/etched variant?)</div>
            )}
          </div>

          <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
            {card.url_slug ? (
              <a
                href={`https://www.cardkingdom.com${card.url_slug.startsWith('/') ? '' : '/'}${card.url_slug}`}
                target="_blank"
                rel="noreferrer"
                style={{ padding: '6px 12px', border: '1px solid #ddd', borderRadius: 6, background: '#fafafa', color: '#333', fontSize: 13 }}
              >
                Open on Card Kingdom ↗
              </a>
            ) : null}
            {card.scryfall_id ? (
              <a
                href={`https://scryfall.com/card/${card.scryfall_id}`}
                target="_blank"
                rel="noreferrer"
                style={{ padding: '6px 12px', border: '1px solid #ddd', borderRadius: 6, background: '#fafafa', color: '#333', fontSize: 13 }}
              >
                Open on Scryfall ↗
              </a>
            ) : null}
          </div>
        </div>

        <div style={{ textAlign: 'right', minWidth: 180 }}>
          <div className="muted" style={{ fontSize: 12 }}>Best retail (lowest price)</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: '#0a7d27' }}>
            {bestBuy ? `$${bestBuy.price.toFixed(2)}` : '—'}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>{bestBuy?.src ?? ''}</div>

          <div className="muted" style={{ fontSize: 12, marginTop: 12 }}>Best buylist (highest payout)</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>
            {bestSell ? `$${bestSell.price.toFixed(2)}` : '—'}
          </div>
          <div className="muted" style={{ fontSize: 12 }}>{bestSell?.src ?? ''}</div>
        </div>
      </div>

      <h3 style={{ margin: '0 0 8px' }}>All sources — latest</h3>
      <table className="cards">
        <thead>
          <tr>
            <th>Source</th>
            <th>Kind</th>
            <th className="num">Price</th>
            <th>Captured</th>
          </tr>
        </thead>
        <tbody>
          {/* CK direct rows */}
          {ckLatest?.price_retail != null ? (
            <tr>
              <td><span className={`src-tag src-ck`} style={tagStyle('src-ck')}>CK direct</span></td>
              <td>Retail</td>
              <td className="num" style={{ fontWeight: 600 }}>${Number(ckLatest.price_retail).toFixed(2)}</td>
              <td className="muted">{fmtAgo(ckLatest.captured_at)}</td>
            </tr>
          ) : null}
          {ckLatest?.price_buy != null ? (
            <tr>
              <td><span className={`src-tag src-ck`} style={tagStyle('src-ck')}>CK direct</span></td>
              <td>Buylist</td>
              <td className="num" style={{ fontWeight: 600 }}>${Number(ckLatest.price_buy).toFixed(2)}</td>
              <td className="muted">{fmtAgo(ckLatest.captured_at)}</td>
            </tr>
          ) : null}

          {/* MTGJSON rows */}
          {(mjLatest ?? []).map((r) => (
            <tr key={`${r.provider}-${r.kind}`}>
              <td>
                <span style={tagStyle(PROVIDER_TAG_CLASS[r.provider] ?? 'src-mtgo')}>
                  {PROVIDER_LABEL[r.provider] ?? r.provider}
                </span>
              </td>
              <td>{r.kind === 'retail' ? 'Retail' : 'Buylist'}</td>
              <td className="num" style={{ fontWeight: 600 }}>{fmtPrice(Number(r.price), r.currency)}</td>
              <td className="muted">{r.captured_on} ({fmtAgo(`${r.captured_on}T00:00:00Z`)})</td>
            </tr>
          ))}

          {!ckLatest && (mjLatest ?? []).length === 0 ? (
            <tr><td colSpan={4} style={{ padding: 32, textAlign: 'center' }} className="muted">No price data yet.</td></tr>
          ) : null}
        </tbody>
      </table>

      {/* Simple history table */}
      <h3 style={{ margin: '24px 0 8px' }}>History</h3>
      <p className="muted" style={{ marginBottom: 8 }}>
        CK direct keeps {ckHistory?.length ?? 0} snapshots (14d retention). MTGJSON keeps {mjHistory?.length ?? 0} (3d retention).
      </p>
      <table className="cards" style={{ maxWidth: 720 }}>
        <thead>
          <tr>
            <th>Date</th>
            <th>Source</th>
            <th>Kind</th>
            <th className="num">Price</th>
          </tr>
        </thead>
        <tbody>
          {(ckHistory ?? []).slice().reverse().slice(0, 30).map((r) => (
            <Fragment key={`ck-${r.captured_at}`}>
              {r.price_retail != null ? (
                <tr key={`ck-r-${r.captured_at}`}>
                  <td>{new Date(r.captured_at).toLocaleString()}</td>
                  <td><span style={tagStyle('src-ck')}>CK direct</span></td>
                  <td>Retail</td>
                  <td className="num">${Number(r.price_retail).toFixed(2)}</td>
                </tr>
              ) : null}
              {r.price_buy != null ? (
                <tr key={`ck-b-${r.captured_at}`}>
                  <td>{new Date(r.captured_at).toLocaleString()}</td>
                  <td><span style={tagStyle('src-ck')}>CK direct</span></td>
                  <td>Buylist</td>
                  <td className="num">${Number(r.price_buy).toFixed(2)}</td>
                </tr>
              ) : null}
            </Fragment>
          ))}
          {(mjHistory ?? []).slice().reverse().map((r) => (
            <tr key={`mj-${r.provider}-${r.kind}-${r.captured_on}`}>
              <td>{r.captured_on}</td>
              <td>
                <span style={tagStyle(PROVIDER_TAG_CLASS[r.provider] ?? 'src-mtgo')}>
                  {PROVIDER_LABEL[r.provider] ?? r.provider}
                </span>
              </td>
              <td>{r.kind === 'retail' ? 'Retail' : 'Buylist'}</td>
              <td className="num">{fmtPrice(Number(r.price), r.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function tagStyle(cls: string): React.CSSProperties {
  const map: Record<string, { bg: string; color: string }> = {
    'src-ck': { bg: '#fef0e6', color: '#a04500' },
    'src-tcg': { bg: '#e6f0fe', color: '#1d4eb1' },
    'src-mkm': { bg: '#ecf6ec', color: '#1d6e2c' },
    'src-csp': { bg: '#f4ecfa', color: '#6a2ca5' },
    'src-mtgo': { bg: '#f0f0f0', color: '#444' },
  };
  const c = map[cls] ?? map['src-mtgo'];
  return {
    display: 'inline-block',
    padding: '1px 6px',
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
    background: c.bg,
    color: c.color,
  };
}
