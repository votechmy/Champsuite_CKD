import Link from 'next/link';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const supa = getSupabaseAdmin();
  const { count: cardCount } = await supa
    .from('cards')
    .select('*', { count: 'exact', head: true });
  const { data: lastRun } = await supa
    .from('sync_runs')
    .select('id, started_at, finished_at, status, rows_in_dump, error')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return (
    <div>
      <h1>ChampSuite CKD</h1>
      <p className="muted">
        Internal Card Kingdom pricelist mirror for the Cards &amp; Hobbies buyer team.
      </p>

      <div style={{ marginTop: 24 }}>
        <p>
          <strong>{cardCount?.toLocaleString() ?? 0}</strong> cards in catalog.
        </p>
        {lastRun ? (
          <p className="muted">
            Last sync: {new Date(lastRun.started_at).toLocaleString()} —{' '}
            <strong>{lastRun.status}</strong>
            {lastRun.rows_in_dump
              ? ` (${lastRun.rows_in_dump.toLocaleString()} rows in dump)`
              : ''}
            {lastRun.error ? ` — error: ${lastRun.error}` : ''}
          </p>
        ) : (
          <p className="muted">No syncs yet. Run <code>pnpm sync</code> or trigger the workflow.</p>
        )}
      </div>

      <p style={{ marginTop: 32 }}>
        <Link href="/list">Browse pricelist →</Link>
      </p>
    </div>
  );
}
