import Link from 'next/link';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

type SearchParams = {
  status?: 'success' | 'failure' | 'running' | '';
  page?: string;
};

function fmtDuration(start: string, end: string | null): string {
  if (!end) return '—';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs}s`;
}

function fmtRel(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function statusChip(status: string) {
  const color =
    status === 'success' ? '#0a7d27' :
    status === 'failure' ? '#c00' :
    status === 'running' ? '#a06600' : '#666';
  const bg =
    status === 'success' ? '#e7f6ec' :
    status === 'failure' ? '#fde8e8' :
    status === 'running' ? '#fff5e0' : '#eee';
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 12,
        color,
        background: bg,
        fontSize: 12,
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: 0.3,
      }}
    >
      {status}
    </span>
  );
}

export default async function SyncLogPage(props: { searchParams: Promise<SearchParams> }) {
  const sp = await props.searchParams;
  const status = sp.status ?? '';
  const page = Math.max(1, Number(sp.page ?? 1) || 1);
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const supa = getSupabaseAdmin();

  // Aggregate stats: last 30 days
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [{ count: totalRecent }, { count: failuresRecent }, { data: lastSuccess }, { data: lastFailure }] =
    await Promise.all([
      supa
        .from('sync_runs')
        .select('*', { count: 'exact', head: true })
        .gte('started_at', since30d),
      supa
        .from('sync_runs')
        .select('*', { count: 'exact', head: true })
        .gte('started_at', since30d)
        .eq('status', 'failure'),
      supa
        .from('sync_runs')
        .select('id, started_at, finished_at, rows_in_dump')
        .eq('status', 'success')
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supa
        .from('sync_runs')
        .select('id, started_at, error')
        .eq('status', 'failure')
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

  // Paginated list with optional status filter
  let listQuery = supa
    .from('sync_runs')
    .select(
      'id, started_at, finished_at, status, triggered_by, rows_in_dump, cards_upserted, prices_inserted, prices_pruned, error',
      { count: 'exact' },
    )
    .order('started_at', { ascending: false });

  if (status === 'success' || status === 'failure' || status === 'running') {
    listQuery = listQuery.eq('status', status);
  }
  listQuery = listQuery.range(from, to);

  const { data: runs, error, count: totalRows } = await listQuery;

  if (error) {
    return (
      <div>
        <h1>Sync log</h1>
        <p style={{ color: '#c00' }}>Error: {error.message}</p>
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil((totalRows ?? 0) / PAGE_SIZE));
  const failureRate30d = (totalRecent ?? 0) > 0
    ? Math.round(((failuresRecent ?? 0) / (totalRecent ?? 1)) * 100)
    : 0;

  return (
    <div>
      <h1>Sync log</h1>
      <p className="muted">
        Daily Card Kingdom pricelist sync history. Cron runs at 08:00 UTC; manual refreshes via the <Link href="/list">/list</Link> page.
      </p>

      {/* Summary cards */}
      <div className="summary-grid">
        <div className="summary-card">
          <div className="summary-label">Last successful sync</div>
          <div className="summary-value">
            {lastSuccess ? (
              <>
                <strong>{fmtRel(lastSuccess.started_at)}</strong>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  {new Date(lastSuccess.started_at).toLocaleString()} · {(lastSuccess.rows_in_dump ?? 0).toLocaleString()} rows
                </div>
              </>
            ) : (
              <span className="muted">No successful sync yet</span>
            )}
          </div>
        </div>

        <div className="summary-card">
          <div className="summary-label">Last failure</div>
          <div className="summary-value">
            {lastFailure ? (
              <>
                <strong style={{ color: '#c00' }}>{fmtRel(lastFailure.started_at)}</strong>
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  {(lastFailure.error ?? '').slice(0, 80)}{(lastFailure.error ?? '').length > 80 ? '…' : ''}
                </div>
              </>
            ) : (
              <span style={{ color: '#0a7d27' }}>None — clean record</span>
            )}
          </div>
        </div>

        <div className="summary-card">
          <div className="summary-label">Last 30 days</div>
          <div className="summary-value">
            <strong>{(totalRecent ?? 0).toLocaleString()}</strong> runs
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              {(failuresRecent ?? 0).toLocaleString()} failures (
              <span style={{ color: failureRate30d > 5 ? '#c00' : '#0a7d27' }}>{failureRate30d}%</span>
              )
            </div>
          </div>
        </div>
      </div>

      {/* Filter */}
      <form className="toolbar" method="get" style={{ marginTop: 24 }}>
        <select name="status" defaultValue={status}>
          <option value="">All statuses</option>
          <option value="success">Success only</option>
          <option value="failure">Failure only</option>
          <option value="running">Running only</option>
        </select>
        <button type="submit">Apply</button>
        <span className="spacer" />
        <Link href="/list" className="muted" style={{ fontSize: 13 }}>
          Trigger manual sync →
        </Link>
      </form>

      <p className="muted" style={{ marginBottom: 8 }}>
        {(totalRows ?? 0).toLocaleString()} runs · page {page} of {totalPages}
      </p>

      <table className="cards">
        <thead>
          <tr>
            <th>#</th>
            <th>Started</th>
            <th>Duration</th>
            <th>Status</th>
            <th>Trigger</th>
            <th className="num">Dump rows</th>
            <th className="num">Cards</th>
            <th className="num">Prices</th>
            <th className="num">Pruned</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {(runs ?? []).map((r) => (
            <tr key={r.id}>
              <td className="muted">#{r.id}</td>
              <td>
                <div>{new Date(r.started_at).toLocaleString()}</div>
                <div className="muted" style={{ fontSize: 12 }}>{fmtRel(r.started_at)}</div>
              </td>
              <td>{fmtDuration(r.started_at, r.finished_at)}</td>
              <td>{statusChip(r.status)}</td>
              <td>
                <code style={{ fontSize: 12 }}>{r.triggered_by ?? '—'}</code>
              </td>
              <td className="num">{r.rows_in_dump?.toLocaleString() ?? '—'}</td>
              <td className="num">{r.cards_upserted?.toLocaleString() ?? '—'}</td>
              <td className="num">{r.prices_inserted?.toLocaleString() ?? '—'}</td>
              <td className="num">{r.prices_pruned?.toLocaleString() ?? '—'}</td>
              <td style={{ maxWidth: 320 }}>
                {r.error ? (
                  <details>
                    <summary style={{ cursor: 'pointer', color: '#c00', fontSize: 13 }}>
                      {r.error.slice(0, 60)}{r.error.length > 60 ? '…' : ''}
                    </summary>
                    <pre
                      style={{
                        marginTop: 8,
                        padding: 8,
                        background: '#fde8e8',
                        border: '1px solid #f5b5b5',
                        borderRadius: 4,
                        fontSize: 11,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        maxHeight: 240,
                        overflow: 'auto',
                      }}
                    >
                      {r.error}
                    </pre>
                  </details>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
            </tr>
          ))}
          {(runs ?? []).length === 0 ? (
            <tr>
              <td colSpan={10} style={{ padding: 32, textAlign: 'center' }} className="muted">
                No sync runs yet. Trigger one from the <Link href="/list">list page</Link>.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <Pagination page={page} totalPages={totalPages} status={status} />
    </div>
  );
}

function Pagination({
  page,
  totalPages,
  status,
}: {
  page: number;
  totalPages: number;
  status: string;
}) {
  const buildHref = (p: number) => {
    const sp = new URLSearchParams();
    if (status) sp.set('status', status);
    sp.set('page', String(p));
    return `/sync-log?${sp.toString()}`;
  };
  return (
    <div className="pagination">
      {page > 1 ? (
        <a href={buildHref(page - 1)}>← Prev</a>
      ) : (
        <span className="disabled">← Prev</span>
      )}
      <span className="muted">Page {page} / {totalPages}</span>
      {page < totalPages ? (
        <a href={buildHref(page + 1)}>Next →</a>
      ) : (
        <span className="disabled">Next →</span>
      )}
    </div>
  );
}
