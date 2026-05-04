import Link from 'next/link';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

type SearchParams = {
  q?: string;
  set?: string;
  condition?: string;
  page?: string;
};

type InventoryRow = {
  uuid: string;
  set_id: string;
  collector_num: number;
  title: string | null;
  condition: string | null;
  is_foil: boolean;
  price: number | null;
  price_trend: number | null;
  ecommerce_id: number | null;
  last_uploaded_at: string;
};

type CatalogRow = {
  set_id: string;
  collector_number: number;
  name: string;
  rarity: string | null;
  type: string | null;
  image_url: string | null;
  tcgplayer_id: number | null;
};

type LatestUpload = {
  id: number;
  uploaded_at: string;
  rows_upserted: number | null;
  filename: string | null;
};

function fmtUSD(n: number | null | undefined): string {
  if (n == null) return '—';
  return `$${Number(n).toFixed(2)}`;
}

function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default async function InventoryPage(props: { searchParams: Promise<SearchParams> }) {
  const sp = await props.searchParams;
  const q = (sp.q ?? '').trim();
  const setFilter = (sp.set ?? '').trim().toUpperCase();
  const condFilter = (sp.condition ?? '').trim().toUpperCase();
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const supa = getSupabaseAdmin();

  let q1 = supa
    .from('riftbound_inventory')
    .select(
      'uuid, set_id, collector_num, title, condition, is_foil, price, price_trend, ecommerce_id, last_uploaded_at',
      { count: 'exact' },
    )
    .order('last_uploaded_at', { ascending: false });

  if (q) q1 = q1.ilike('title', `%${q}%`);
  if (setFilter) q1 = q1.eq('set_id', setFilter);
  if (condFilter) q1 = q1.eq('condition', condFilter);
  q1 = q1.range(from, to);

  const { data: invRows, error, count } = await q1;
  if (error) {
    return (
      <div>
        <h1>Riftbound inventory</h1>
        <p style={{ color: 'var(--up)' }}>Error: {error.message}</p>
        <p className="muted">If this is the first load, apply migration <code>0005_riftbound_inventory.sql</code>.</p>
      </div>
    );
  }
  const inv = (invRows ?? []) as InventoryRow[];

  // Catalog join: pull all matching (set_id, collector_number) for this page.
  const keys = inv.map((r) => `${r.set_id}|${r.collector_num}`);
  const setIds = Array.from(new Set(inv.map((r) => r.set_id)));
  const collectorNums = Array.from(new Set(inv.map((r) => r.collector_num)));

  const catalogMap = new Map<string, CatalogRow>();
  if (setIds.length > 0) {
    const { data: cat } = await supa
      .from('riftbound_cards')
      .select('set_id, collector_number, name, rarity, type, image_url, tcgplayer_id')
      .in('set_id', setIds)
      .in('collector_number', collectorNums);
    for (const c of (cat ?? []) as CatalogRow[]) {
      catalogMap.set(`${c.set_id}|${c.collector_number}`, c);
    }
  }

  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));

  // Distinct sets/conditions for filter dropdowns.
  const { data: distinctSets } = await supa.from('riftbound_inventory').select('set_id').limit(2000);
  const setList = Array.from(new Set((distinctSets ?? []).map((r) => r.set_id))).filter(Boolean) as string[];
  setList.sort();

  // Latest upload summary.
  const { data: lastUpload } = await supa
    .from('riftbound_uploads')
    .select('id, uploaded_at, rows_upserted, filename')
    .order('uploaded_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const lu = lastUpload as LatestUpload | null;

  return (
    <div>
      <h1>Riftbound inventory</h1>
      <p className="muted" style={{ marginTop: 6 }}>
        Scanner uploads, joined to Riftcodex catalog. {(count ?? 0).toLocaleString()} cards total.
        {lu ? (
          <>
            {' '}Last upload <strong>#{lu.id}</strong> {fmtAgo(lu.uploaded_at)} · {(lu.rows_upserted ?? 0).toLocaleString()} rows
            {lu.filename ? ` (${lu.filename})` : ''}.
          </>
        ) : (
          <> No uploads yet — <Link href="/riftbound/upload">upload your first TSV</Link>.</>
        )}
      </p>

      <form className="toolbar" method="get" style={{ marginTop: 16 }}>
        <input type="text" name="q" placeholder="Search by title…" defaultValue={q} />
        <select name="set" defaultValue={setFilter}>
          <option value="">All sets</option>
          {setList.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select name="condition" defaultValue={condFilter}>
          <option value="">Any condition</option>
          <option value="NM">NM</option>
          <option value="LP">LP</option>
          <option value="EX">EX</option>
          <option value="VG">VG</option>
          <option value="G">G</option>
        </select>
        <button type="submit">Apply</button>
        <span className="spacer" />
        <Link href="/riftbound/upload" className="muted" style={{ fontSize: 13 }}>
          Upload TSV →
        </Link>
      </form>

      <p className="muted" style={{ marginBottom: 8 }}>
        Page {page} of {totalPages}
      </p>

      <table className="cards">
        <thead>
          <tr>
            <th></th>
            <th>Card</th>
            <th>Set / #</th>
            <th>Condition</th>
            <th>Foil</th>
            <th className="num">Our price</th>
            <th className="num">Market</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {inv.map((row) => {
            const cat = catalogMap.get(`${row.set_id}|${row.collector_num}`);
            const display = cat?.name ?? row.title ?? '(unknown)';
            return (
              <tr key={row.uuid}>
                <td style={{ width: 64 }}>
                  {cat?.image_url ? (
                    <button
                      type="button"
                      className="thumb"
                      data-card-thumb="1"
                      data-card-img-large={cat.image_url}
                      data-card-name={display}
                      data-card-meta={`${row.set_id} · #${row.collector_num}`}
                      aria-label={`Enlarge ${display}`}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={cat.image_url} alt={display} loading="lazy" width={56} height={78} />
                    </button>
                  ) : (
                    <span className="thumb">
                      <span className="thumb-fallback">{(display[0] ?? '?').toUpperCase()}</span>
                    </span>
                  )}
                </td>
                <td>
                  <div>{display}</div>
                  <div className="muted" style={{ fontSize: 12, display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    {cat?.type ? (
                      <span>
                        {cat.type}
                        {cat.rarity ? ` · ${cat.rarity}` : ''}
                      </span>
                    ) : null}
                    {cat?.tcgplayer_id ? (
                      <a
                        href={`https://www.tcgplayer.com/product/${cat.tcgplayer_id}`}
                        target="_blank"
                        rel="noreferrer"
                        title="Open on TCGplayer"
                        style={{ fontSize: 12 }}
                      >
                        TCGplayer ↗
                      </a>
                    ) : null}
                  </div>
                </td>
                <td>
                  <code style={{ fontSize: 12 }}>{row.set_id}</code> · #{row.collector_num}
                </td>
                <td>{row.condition ?? '—'}</td>
                <td>{row.is_foil ? 'foil' : ''}</td>
                <td className="num">{fmtUSD(row.price)}</td>
                <td className="num">{fmtUSD(row.price_trend)}</td>
                <td className="muted">{fmtAgo(row.last_uploaded_at)}</td>
              </tr>
            );
          })}
          {inv.length === 0 ? (
            <tr>
              <td colSpan={8} style={{ padding: 32, textAlign: 'center' }} className="muted">
                No inventory yet. <Link href="/riftbound/upload">Upload a TSV</Link> to populate.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <Pagination page={page} totalPages={totalPages} q={q} setFilter={setFilter} condFilter={condFilter} />
    </div>
  );
}

function Pagination({
  page,
  totalPages,
  q,
  setFilter,
  condFilter,
}: {
  page: number;
  totalPages: number;
  q: string;
  setFilter: string;
  condFilter: string;
}) {
  const buildHref = (p: number) => {
    const sp = new URLSearchParams();
    if (q) sp.set('q', q);
    if (setFilter) sp.set('set', setFilter);
    if (condFilter) sp.set('condition', condFilter);
    sp.set('page', String(p));
    return `/riftbound/inventory?${sp.toString()}`;
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
