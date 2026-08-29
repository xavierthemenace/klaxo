import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db';
import { getEnv } from '@/lib/env';

/** Readiness probe: validates the configured runtime before accepting traffic. */
export async function GET(): Promise<NextResponse> {
  try {
    const env = getEnv();
    getDb().run(sql`SELECT 1`);

    return NextResponse.json({
      ok: true,
      service: 'klaxo',
      checks: {
        database: 'ok',
        ai: env.AI_DEV_MODE ? 'development-fixtures' : 'configured',
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        service: 'klaxo',
        error: error instanceof Error ? error.message : 'Readiness check failed',
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}
