import Link from 'next/link';
import { getSupabaseAdmin } from '@/lib/supabase/admin';
import { CardThumb } from '@/components/CardThumb';

export const dynamic = 'force-dynamic';

function fmtAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fmtUSD(n: number | null | undefined, withSign = false): string {
  if (n == null) return '—';
  const v = Number(n);
  const sign = withSign && v > 0 ? '+' : '';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

type Mover = {
  card_id: number;
  price_today: number;
  price_prev: number;
  delta: number;
  pct_change: number;
};

type CardLite = {
  id: number;
  name: string;
  edition: string | null;
  is_foil: boolean;
  scryfall_id: string | null;
};

type Opportunity = {
  card_id: number;
  name: string;
  edition: string | null;
  is_foil: boolean;
  scryfall_id: string | null;
  ck_buy: number;
  tcg_retail: number;
  spread: number;
};

type RunRow = {
  id: number;
  feed: 'CK' | 'MTGJSON';
  started_at: string;
  status: string;
};

export default async function Dashboard() {
  const supa = getSupabaseAdmin();

  const [
    { count: cardCount },
    { data: lastCk },
    { data: lastMj },
    { count: ckRunsToday },
    { count: mjRunsToday },
    { data: rawMovers },
    { data: opportunities },
    { data: ckRecent },
    { data: mjRecent },
  ] = await Promise.all([
    supa.from('cards').select('*', { count: 'exact', head: true }),
    supa
      .from('sync_runs')
      .select('id, started_at, status, rows_in_dump')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supa
      .from('mtgjson_sync_runs')
      .select('id, started_at, status, uuids_matched_ck')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supa
      .from('sync_runs')
      .select('*', { count: 'exact', head: true })
      .gte('started_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString()),
    supa
      .from('mtgjson_sync_runs')
      .select('*', { count: 'exact', head: true })
      .gte('started_at', new Date(Date.now() - 24 * 3600 * 1000).toISOString()),
    supa
      .from('card_movers_24h')
      .select('card_id, price_today, price_prev, delta, pct_change')
      .limit(10),
    supa
      .from('buylist_opportunities')
      .select('card_id, name, edition, is_foil, scryfall_id, ck_buy, tcg_retail, spread')
      .limit(10),
    supa
      .from('sync_runs')
      .select('id, started_at, status')
      .order('started_at', { ascending: false })
      .limit(3),
    supa
      .from('mtgjson_sync_runs')
      .select('id, started_at, status')
      .order('started_at', { ascending: false })
      .limit(3),
  ]);

  // Resolve mover card_ids → name/edition/scryfall_id in one round-trip.
  const moverIds = (rawMovers ?? []).map((m: Mover) => m.card_id);
  let moverCards: Record<number, CardLite> = {};
  if (moverIds.length > 0) {
    const { data } = await supa
      .from('cards')
      .select('id, name, edition, is_foil, scryfall_id')
      .in('id', moverIds);
    for (const c of (data ?? []) as CardLite[]) moverCards[c.id] = c;
  }

  const movers = (rawMovers ?? []) as Mover[];
  const opps = (opportunities ?? []) as Opportunity[];

  const allRuns: RunRow[] = [
    ...((ckRecent ?? []) as Array<{ id: number; started_at: string; status: string }>).map((r) => ({
      ...r,
      feed: 'CK' as const,
    })),
    ...((mjRecent ?? []) as Array<{ id: number; started_at: string; status: string }>).map((r) => ({
      ...r,
      feed: 'MTGJSON' as const,
    })),
  ]
    .sort((a, b) => +new Date(b.started_at) - +new Date(a.started_at))
    .slice(0, 5);

  return (
    <div>
      <div style={{ marginBottom: 'var(--s-3)' }}>
        <h1>Pricing terminal</h1>
        <p className="muted" style={{ marginTop: 6 }}>
          Card Kingdom direct sync + MTGJSON multi-source reference. Source of truth for buy decisions.
        </p>
      </div>

      <div className="dash-hero">
        <div className="summary-card">
          <div className="summary-label">Cards in catalog</div>
          <div className="stat-big">{(cardCount ?? 0).toLocaleString()}</div>
          <div className="summary-sub">CK pricelist universe</div>
        </div>
        <div className="summary-card">
          <div className="summary-label">Last CK sync</div>
          <div className="stat-big">{fmtAgo(lastCk?.started_at)}</div>
          <div className="summary-sub">
            {lastCk?.status === 'success' ? `${(lastCk?.rows_in_dump ?? 0).toLocaleString()} rows` : (lastCk?.status ?? 'never')}
          </div>
        </div>
        <div className="summary-card">
          <div className="summary-label">Last MTGJSON sync</div>
          <div className="stat-big">{fmtAgo(lastMj?.started_at)}</div>
          <div className="summary-sub">
            {lastMj?.status === 'success' ? `${(lastMj?.uuids_matched_ck ?? 0).toLocaleString()} matched` : (lastMj?.status ?? 'never')}
          </div>
        </div>
        <div className="summary-card">
          <div className="summary-label">Runs in last 24h</div>
          <div className="stat-big">{(ckRunsToday ?? 0) + (mjRunsToday ?? 0)}</div>
          <div className="summary-sub">CK {ckRunsToday ?? 0} · MTGJSON {mjRunsToday ?? 0}</div>
        </div>
      </div>

      <form className="dash-search" action="/list" method="get">
        <input type="text" name="q" placeholder="Search 146,000+ cards by name… (e.g. Lightning Bolt, Sol Ring)" />
        <button type="submit">Search</button>
      </form>

      <div className="dash-grid">

        <section className="panel">
          <div className="panel-head">
            <h3>Today&apos;s biggest movers</h3>
            <span className="legend">
              <span><strong className="up">red</strong> = price up (costs more)</span>
              <span><strong className="down">green</strong> = price down (opportunity)</span>
            </span>
          </div>
          <div className="panel-body">
            <ul className="panel-list">
              {movers.length === 0 ? (
                <li><span className="empty">No movers yet — need at least 2 days of CK snapshots.</span></li>
              ) : (
                movers.map((m) => {
                  const card = moverCards[m.card_id];
                  const dir = m.delta > 0 ? 'up' : 'down';
                  const pct = (Number(m.pct_change) * 100).toFixed(1);
                  return (
                    <li key={m.card_id}>
                      <CardThumb
                        scryfallId={card?.scryfall_id}
                        name={card?.name ?? `#${m.card_id}`}
                        edition={card?.edition}
                        finish={card?.is_foil ? 'foil' : 'nonfoil'}
                      />
                      <Link href={`/card/${m.card_id}`} style={{ minWidth: 0 }}>
                        <div className="name">{card?.name ?? `Card #${m.card_id}`}</div>
                        <div className="sub">
                          {card?.edition ?? ''}
                          {card?.is_foil ? ' · foil' : ''}
                          {' · '}
                          {fmtUSD(m.price_prev)} → {fmtUSD(m.price_today)}
                        </div>
                      </Link>
                      <div className="price">
                        <div className={dir === 'up' ? 'delta-up' : 'delta-down'}>
                          {dir === 'up' ? '+' : ''}{pct}%
                        </div>
                        <div className="muted" style={{ fontSize: 11 }}>
                          {fmtUSD(m.delta, true)}
                        </div>
                      </div>
                    </li>
                  );
                })
              )}
            </ul>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>Buylist opportunities</h3>
            <span className="panel-sub">CK pays {`>`} TCG asks</span>
          </div>
          <div className="panel-body">
            <ul className="panel-list">
              {opps.length === 0 ? (
                <li><span className="empty">No arbitrage signals right now. Check back after the next MTGJSON sync.</span></li>
              ) : (
                opps.map((o) => (
                  <li key={`${o.card_id}-${o.is_foil}`}>
                    <CardThumb
                      scryfallId={o.scryfall_id}
                      name={o.name}
                      edition={o.edition}
                      finish={o.is_foil ? 'foil' : 'nonfoil'}
                    />
                    <Link href={`/compare/${o.card_id}`} style={{ minWidth: 0 }}>
                      <div className="name">{o.name}</div>
                      <div className="sub">
                        {o.edition ?? ''}
                        {o.is_foil ? ' · foil' : ''}
                        {' · TCG '}{fmtUSD(o.tcg_retail)} → CK buy {fmtUSD(o.ck_buy)}
                      </div>
                    </Link>
                    <div className="price">
                      <div className="delta-down">+{fmtUSD(o.spread)}</div>
                      <div className="muted" style={{ fontSize: 11 }}>per copy</div>
                    </div>
                  </li>
                ))
              )}
            </ul>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>Sync activity</h3>
            <span className="panel-sub">last 5</span>
          </div>
          <div className="panel-body">
            {allRuns.length === 0 ? (
              <span className="empty">No syncs yet.</span>
            ) : (
              allRuns.map((r) => (
                <div className="run-row" key={`${r.feed}-${r.id}`}>
                  <span className={`pill ${r.status === 'success' ? 'pill-success' : r.status === 'failure' ? 'pill-failure' : 'pill-running'}`}>
                    {r.status}
                  </span>
                  <div>
                    <div className="feed">{r.feed}</div>
                    <div className="when">{fmtAgo(r.started_at)}</div>
                  </div>
                  <Link href="/sync-log" className="muted" style={{ fontSize: 12 }}>view</Link>
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      <div className="quick-links">
        <Link href="/list">Browse pricelist →</Link>
        <Link href="/compare">Compare across sources →</Link>
        <Link href="/sync-log">Full sync history →</Link>
      </div>
    </div>
  );
}
