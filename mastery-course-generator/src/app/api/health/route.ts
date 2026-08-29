import { NextResponse } from 'next/server';

/** Liveness probe: no dependency checks, safe for process/container health. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    ok: true,
    service: 'klaxo',
    timestamp: new Date().toISOString(),
  });
}
