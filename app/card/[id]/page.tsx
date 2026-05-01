import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function CardPage(props: { params: Promise<{ id: string }> }) {
  const { id: rawId } = await props.params;
  const id = Number(rawId);
  if (!Number.isFinite(id)) notFound();

  const supa = getSupabaseAdmin();
  const { data: card } = await supa
    .from('cards')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (!card) notFound();

  const { data: history } = await supa
    .from('card_prices')
    .select('captured_at, price_retail, qty_retail, price_buy, qty_buying')
    .eq('card_id', id)
    .order('captured_at', { ascending: false })
    .limit(60);

  return (
    <div>
      <p>
        <Link href="/list">← Back to list</Link>
      </p>
      <h1>{card.name}</h1>
      <p className="muted">
        {card.edition ?? 'Unknown edition'}
        {card.variation ? ` · ${card.variation}` : ''}
        {card.is_foil ? ' · foil' : ''}
        {' · sku '}
        <code>{card.sku}</code>
        {card.scryfall_id ? (
          <>
            {' · '}
            <a
              href={`https://scryfall.com/card/${card.scryfall_id}`}
              target="_blank"
              rel="noreferrer"
            >
              Scryfall
            </a>
          </>
        ) : null}
        {card.url_slug ? (
          <>
            {' · '}
            <a
              href={`https://www.cardkingdom.com/${card.url_slug}`}
              target="_blank"
              rel="noreferrer"
            >
              Card Kingdom
            </a>
          </>
        ) : null}
      </p>

      <h2 style={{ marginTop: 32 }}>Price history (last 60 snapshots)</h2>
      {(history ?? []).length === 0 ? (
        <p className="muted">No snapshots yet.</p>
      ) : (
        <table className="cards history-table">
          <thead>
            <tr>
              <th>Captured</th>
              <th className="num">Retail</th>
              <th className="num">Qty retail</th>
              <th className="num">Buylist</th>
              <th className="num">Qty buying</th>
            </tr>
          </thead>
          <tbody>
            {(history ?? []).map((h) => (
              <tr key={h.captured_at}>
                <td>{new Date(h.captured_at).toLocaleString()}</td>
                <td className="num">
                  {h.price_retail != null ? `$${Number(h.price_retail).toFixed(2)}` : '—'}
                </td>
                <td className="num">{h.qty_retail ?? '—'}</td>
                <td className="num">
                  {h.price_buy != null ? `$${Number(h.price_buy).toFixed(2)}` : '—'}
                </td>
                <td className="num">{h.qty_buying ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
