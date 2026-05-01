'use client';

import { useState } from 'react';

export function RefreshButton() {
  const [state, setState] = useState<'idle' | 'pending' | 'ok' | 'err'>('idle');
  const [msg, setMsg] = useState<string>('');

  async function trigger() {
    setState('pending');
    setMsg('');
    try {
      const res = await fetch('/api/refresh', { method: 'POST' });
      const body = await res.json();
      if (!res.ok) {
        setState('err');
        setMsg(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setState('ok');
      setMsg(body.runUrl ? `Started — ${body.runUrl}` : 'Started');
    } catch (e) {
      setState('err');
      setMsg(e instanceof Error ? e.message : 'Failed');
    }
  }

  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
      <button onClick={trigger} disabled={state === 'pending'} type="button">
        {state === 'pending' ? 'Triggering...' : 'Refresh now'}
      </button>
      {msg ? (
        <span className="muted" style={{ color: state === 'err' ? '#c00' : undefined }}>
          {msg}
        </span>
      ) : null}
    </span>
  );
}
