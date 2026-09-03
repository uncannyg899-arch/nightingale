import { NextRequest, NextResponse } from 'next/server';
import { processIntakeMessage } from '@/lib/intake';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: 'Request body must be valid JSON' },
        { status: 400 }
      );
    }

    const { clinicId, sessionId, text } = (body ?? {}) as Record<string, string>;

    if (!clinicId || !sessionId || typeof text !== 'string' || !text.trim()) {
      return NextResponse.json(
        { error: 'clinicId, sessionId and non-empty text are required' },
        { status: 400 }
      );
    }

    if (text.length > 4000) {
      return NextResponse.json({ error: 'Message too long' }, { status: 413 });
    }

    const result = await processIntakeMessage({ clinicId, sessionId, text });
    return NextResponse.json(result);
  } catch (err) {
    console.error('[intake]', err);
    return NextResponse.json(
      { error: 'Unable to process message' },
      { status: 500 }
    );
  }
}