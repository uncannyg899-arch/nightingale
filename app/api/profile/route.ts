import { NextRequest, NextResponse } from 'next/server';
import { getProfile } from '@/lib/memory';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get('sessionId');
  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId required' }, { status: 400 });
  }

  try {
    const profile = await getProfile(sessionId);
    return NextResponse.json({ facts: profile });
  } catch (err) {
    console.error('[profile]', err);
    return NextResponse.json({ error: 'Unable to load profile' }, { status: 500 });
  }
}
