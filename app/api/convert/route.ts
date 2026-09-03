import { NextRequest, NextResponse } from 'next/server';
import {
  getEscalationQueue,
  getLeads,
  getFunnelSummary,
  getEscalationQuality,
  acknowledgeEscalation,
  clearEscalation,
} from '@/lib/clinician';

export const runtime = 'nodejs';

/**
 * NOTE: this route currently trusts the clinicId query parameter.
 * In production it must read the caller's clinic from an authenticated
 * session — see TECHNICAL_BRIEF.md §10, auth is designed but unbuilt.
 * Documented rather than silently assumed.
 */
export async function GET(req: NextRequest) {
  const clinicId = req.nextUrl.searchParams.get('clinicId');
  if (!clinicId) {
    return NextResponse.json({ error: 'clinicId required' }, { status: 400 });
  }

  try {
    const [queue, leads, funnel, quality] = await Promise.all([
      getEscalationQueue(clinicId),
      getLeads(clinicId),
      getFunnelSummary(clinicId),
      getEscalationQuality(clinicId),
    ]);

    return NextResponse.json({ queue, leads, funnel, quality });
  } catch (err) {
    console.error('[clinician]', err);
    return NextResponse.json({ error: 'Unable to load' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const { action, escalationId, memberId, clinicallyAppropriate } =
      (body ?? {}) as Record<string, string | boolean>;

    if (!action || !escalationId || !memberId) {
      return NextResponse.json(
        { error: 'action, escalationId and memberId are required' },
        { status: 400 }
      );
    }

    if (action === 'acknowledge') {
      const r = await acknowledgeEscalation({
        escalationId: escalationId as string,
        memberId: memberId as string,
      });
      return NextResponse.json(r, { status: r.ok ? 200 : 400 });
    }

    if (action === 'clear') {
      if (typeof clinicallyAppropriate !== 'boolean') {
        return NextResponse.json(
          { error: 'clinicallyAppropriate (boolean) is required to clear' },
          { status: 400 }
        );
      }
      const r = await clearEscalation({
        escalationId: escalationId as string,
        memberId: memberId as string,
        clinicallyAppropriate,
      });
      return NextResponse.json(r, { status: r.ok ? 200 : 400 });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err) {
    console.error('[clinician]', err);
    return NextResponse.json({ error: 'Action failed' }, { status: 500 });
  }
}
