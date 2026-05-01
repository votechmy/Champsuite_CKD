import Link from 'next/link';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { RefreshButton } from './refresh-button';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

type SearchParams = {
  q?: string;
  edition?: string;
  foil?: string;
  page?: string;
  sort?: 'price_desc' | 'price_asc' | 'name_asc';
};

export default async function ListPage(props: { searchParams: Promise<SearchParams> }) {
  const sp = await props.searchParams;
  const q = (sp.q ?? '').trim();
  const edition = (sp.edition ?? '').trim();
  const foil = sp.foil ?? '';
  const sort = sp.sort ?? 'name_asc';
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const supa = getSupabaseAdmin();

  // Filter on `cards` first (indexable), then join latest prices.
  let query = supa
    .from('cards')
    .select(
      `id, sku, name, edition, variation, is_foil,
       card_prices_latest!inner ( price_retail, qty_retail, price_buy, qty_buying, captured_at )`,
      { count: 'exact' },
    );

  if (q) query = query.ilike('name', `%${q}%`);
  if (edition) query = query.eq('edition', edition);
  if (foil === 'true') query = query.eq('is_foil', true);
  else if (foil === 'false') query = query.eq('is_foil', false);

  if (sort === 'name_asc') query = query.order('name', { ascending: true });
  else if (sort === 'price_desc')
    query = query.order('price_retail', { ascending: false, foreignTable: 'card_prices_latest' });
  else if (sort === 'price_asc')
    query = query.order('price_retail', { ascending: true, foreignTable: 'card_prices_latest' });

  query = query.range(from, to);

  const { data, error, count } = await query;
  if (error) {
    return (
      <div>
        <h1>Pricelist</h1>
        <p style={{ color: '#c00' }}>Error: {error.message}</p>
        <p className="muted">
          If this is the first run, you may need to apply migrations and sync. See README.
        </p>
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));

  // Distinct editions for the filter dropdown. Cached separately would be nicer
  // but for now an extra small query keeps this self-contained.
  const { data: editions } = await supa
    .from('cards')
    .select('edition')
    .not('edition', 'is', null)
    .order('edition', { ascending: true })
    .limit(2000);
  const editionList = Array.from(new Set((editions ?? []).map((r) => r.edition))).filter(Boolean) as string[];

  return (
    <div>
      <h1>Pricelist</h1>

      <form className="toolbar" method="get">
        <input
          type="text"
          name="q"
          placeholder="Search by card name..."
          defaultValue={q}
        />
        <select name="edition" defaultValue={edition}>
          <option value="">All editions</option>
          {editionList.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
        <select name="foil" defaultValue={foil}>
          <option value="">Foil & non-foil</option>
          <option value="false">Non-foil only</option>
          <option value="true">Foil only</option>
        </select>
        <select name="sort" defaultValue={sort}>
          <option value="name_asc">Sort: Name A→Z</option>
          <option value="price_desc">Sort: Retail high→low</option>
          <option value="price_asc">Sort: Retail low→high</option>
        </select>
        <button type="submit">Apply</button>
        <span className="spacer" />
        <RefreshButton />
      </form>

      <p className="muted" style={{ marginBottom: 8 }}>
        {(count ?? 0).toLocaleString()} matches · page {page} of {totalPages}
      </p>

      <table className="cards">
        <thead>
          <tr>
            <th>Name</th>
            <th>Edition</th>
            <th>Foil</th>
            <th className="num">Retail</th>
            <th className="num">Qty</th>
            <th className="num">Buylist</th>
            <th className="num">Buying</th>
            <th>As of</th>
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((row) => {
            const latest = Array.isArray(row.card_prices_latest)
              ? row.card_prices_latest[0]
              : (row.card_prices_latest as
                  | {
                      price_retail: number | null;
                      qty_retail: number | null;
                      price_buy: number | null;
                      qty_buying: number | null;
                      captured_at: string;
                    }
                  | null);
            return (
              <tr key={row.id}>
                <td>
                  <Link href={`/card/${row.id}`}>{row.name}</Link>
                  {row.variation ? <span className="muted"> · {row.variation}</span> : null}
                </td>
                <td>{row.edition ?? '—'}</td>
                <td>{row.is_foil ? 'foil' : ''}</td>
                <td className="num">
                  {latest?.price_retail != null ? `$${Number(latest.price_retail).toFixed(2)}` : '—'}
                </td>
                <td className="num">{latest?.qty_retail ?? '—'}</td>
                <td className="num">
                  {latest?.price_buy != null ? `$${Number(latest.price_buy).toFixed(2)}` : '—'}
                </td>
                <td className="num">{latest?.qty_buying ?? '—'}</td>
                <td className="muted">
                  {latest?.captured_at
                    ? new Date(latest.captured_at).toLocaleDateString()
                    : '—'}
                </td>
              </tr>
            );
          })}
          {(data ?? []).length === 0 ? (
            <tr>
              <td colSpan={8} style={{ padding: 32, textAlign: 'center' }} className="muted">
                No matches.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <Pagination
        page={page}
        totalPages={totalPages}
        params={{ q, edition, foil, sort }}
      />
    </div>
  );
}

function Pagination({
  page,
  totalPages,
  params,
}: {
  page: number;
  totalPages: number;
  params: Record<string, string>;
}) {
  const buildHref = (p: number) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
    sp.set('page', String(p));
    return `/list?${sp.toString()}`;
  };
  return (
    <div className="pagination">
      {page > 1 ? (
        <a href={buildHref(page - 1)}>← Prev</a>
      ) : (
        <span className="disabled">← Prev</span>
      )}
      <span className="muted">
        Page {page} / {totalPages}
      </span>
      {page < totalPages ? (
        <a href={buildHref(page + 1)}>Next →</a>
      ) : (
        <span className="disabled">Next →</span>
      )}
    </div>
  );
}
