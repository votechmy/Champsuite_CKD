import { NextResponse } from 'next/server';

// Public read-only API — same-origin policy doesn't help us here, and the
// data is already public (CK pricelist is openly accessible). Keep it simple.
export function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  };
}

export function withCors<T>(json: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(json, { ...init, headers: { ...corsHeaders(), ...(init?.headers ?? {}) } });
}

export function preflight(): NextResponse {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}
