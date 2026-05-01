import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

export const runtime = 'nodejs';

/**
 * POST /api/refresh
 * Triggers the GH Actions sync workflow via workflow_dispatch.
 * Server-side rate-limited via REFRESH_COOLDOWN_SECONDS to prevent hammering.
 */
export async function POST() {
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const workflow = process.env.GITHUB_WORKFLOW_FILE ?? 'sync.yml';
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  const cooldown = Number(process.env.REFRESH_COOLDOWN_SECONDS ?? 600);

  if (!owner || !repo || !token) {
    return NextResponse.json(
      { error: 'Server missing GITHUB_OWNER / GITHUB_REPO / GITHUB_DISPATCH_TOKEN' },
      { status: 500 },
    );
  }

  // Rate-limit: refuse if a manual run started within the cooldown.
  const supa = getSupabaseAdmin();
  const since = new Date(Date.now() - cooldown * 1000).toISOString();
  const { data: recent } = await supa
    .from('sync_runs')
    .select('id, started_at, triggered_by')
    .like('triggered_by', 'manual%')
    .gte('started_at', since)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (recent) {
    const waitMs = cooldown * 1000 - (Date.now() - new Date(recent.started_at).getTime());
    return NextResponse.json(
      {
        error: `A manual sync ran ${Math.round(
          (Date.now() - new Date(recent.started_at).getTime()) / 1000,
        )}s ago. Try again in ${Math.max(0, Math.round(waitMs / 1000))}s.`,
      },
      { status: 429 },
    );
  }

  const dispatchUrl = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`;
  const res = await fetch(dispatchUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      ref: 'main',
      inputs: { triggered_by: 'web-refresh-button' },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json(
      { error: `GitHub returned ${res.status}: ${text.slice(0, 500)}` },
      { status: 502 },
    );
  }

  const runUrl = `https://github.com/${owner}/${repo}/actions/workflows/${workflow}`;
  return NextResponse.json({ ok: true, runUrl });
}
