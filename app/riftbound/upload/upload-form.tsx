'use client';

import { useState } from 'react';

type Result =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'ok'; batchId: number; parsed: number; upserted: number; failed: number; errors?: string[] }
  | { kind: 'err'; status: number; message: string };

export function UploadForm() {
  const [file, setFile] = useState<File | null>(null);
  const [token, setToken] = useState('');
  const [result, setResult] = useState<Result>({ kind: 'idle' });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setResult({ kind: 'pending' });

    const fd = new FormData();
    fd.append('file', file);

    try {
      const res = await fetch('/api/admin/upload-riftbound-inventory', {
        method: 'POST',
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
        body: fd,
      });
      const body = await res.json();
      if (!res.ok) {
        setResult({ kind: 'err', status: res.status, message: body.error ?? `HTTP ${res.status}` });
        return;
      }
      setResult({
        kind: 'ok',
        batchId: body.batchId,
        parsed: body.parsed,
        upserted: body.upserted,
        failed: body.failed,
        errors: body.errors,
      });
    } catch (e) {
      setResult({ kind: 'err', status: 0, message: e instanceof Error ? e.message : 'Network error' });
    }
  }

  return (
    <form onSubmit={submit} style={{ maxWidth: 560 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={{ display: 'block' }}>
          <div className="summary-label" style={{ marginBottom: 6 }}>Upload token</div>
          <input
            type="password"
            placeholder="UPLOAD_TOKEN env value"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            style={{
              width: '100%',
              padding: '10px 12px',
              border: '1px solid var(--border-2)',
              borderRadius: 'var(--r-sm)',
              fontFamily: 'var(--font-mono)',
              fontSize: 13,
            }}
          />
        </label>

        <label style={{ display: 'block' }}>
          <div className="summary-label" style={{ marginBottom: 6 }}>TSV file</div>
          <input
            type="file"
            accept=".tsv,.txt,.csv"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            style={{ display: 'block', fontSize: 14 }}
          />
        </label>

        <button
          type="submit"
          disabled={!file || result.kind === 'pending'}
          style={{
            padding: '10px 18px',
            background: 'var(--ink)',
            color: '#fff',
            border: 0,
            borderRadius: 'var(--r-md)',
            fontSize: 14,
            fontWeight: 500,
            cursor: file && result.kind !== 'pending' ? 'pointer' : 'not-allowed',
            opacity: file && result.kind !== 'pending' ? 1 : 0.5,
            alignSelf: 'flex-start',
          }}
        >
          {result.kind === 'pending' ? 'Uploading…' : 'Upload'}
        </button>
      </div>

      {result.kind === 'ok' ? (
        <div
          style={{
            marginTop: 24,
            padding: 16,
            background: '#DCFCE7',
            border: '1px solid #86EFAC',
            borderRadius: 'var(--r-md)',
            fontSize: 14,
          }}
        >
          <strong style={{ color: '#166534' }}>Upload #{result.batchId} succeeded.</strong>
          <div style={{ marginTop: 6, color: '#166534' }}>
            Parsed {result.parsed.toLocaleString()} rows, upserted {result.upserted.toLocaleString()}, failed{' '}
            {result.failed.toLocaleString()}.
          </div>
          {result.errors && result.errors.length > 0 ? (
            <details style={{ marginTop: 8, fontSize: 12 }}>
              <summary style={{ cursor: 'pointer' }}>Parse warnings ({result.errors.length})</summary>
              <ul style={{ margin: '8px 0 0 16px' }}>
                {result.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </details>
          ) : null}
          <div style={{ marginTop: 12, fontSize: 13 }}>
            <a href="/riftbound/inventory">View inventory →</a>
          </div>
        </div>
      ) : null}

      {result.kind === 'err' ? (
        <div
          style={{
            marginTop: 24,
            padding: 16,
            background: '#FEE2E2',
            border: '1px solid #FCA5A5',
            borderRadius: 'var(--r-md)',
            color: '#991B1B',
            fontSize: 14,
          }}
        >
          <strong>Upload failed (HTTP {result.status}):</strong> {result.message}
        </div>
      ) : null}
    </form>
  );
}
