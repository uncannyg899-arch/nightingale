/**
 * Living Memory
 * ---------------------------------------------------------------
 * A structured, versioned patient profile built from conversation,
 * where every fact points back to the message it came from.
 *
 * THREE DESIGN COMMITMENTS:
 *
 * 1. PROVENANCE IS MANDATORY. A fact with no citation is not written.
 *    If we cannot say which message a claim came from, the claim does
 *    not enter the profile. This is what makes the memory auditable
 *    rather than merely plausible.
 *
 * 2. CORRECTIONS SUPERSEDE, THEY DO NOT OVERWRITE. When a patient
 *    says "actually I'm not allergic to penicillin", the old fact is
 *    marked superseded and the new one points back to it. The
 *    correction trail survives — which matters clinically (someone
 *    may need to know a patient once believed they had an allergy)
 *    and matters for our own provenance claim, which would otherwise
 *    be undermined by its own mutation logic.
 *
 * 3. EXTRACTION RUNS ON REDACTED TEXT. The model that reads messages
 *    to build the profile never sees raw PHI.
 */

import 'server-only';
import { serviceClient } from './supabase';
import { completeOrNull } from './llm';

export type FactKind =
  | 'chief_complaint'
  | 'medication'
  | 'allergy'
  | 'condition'
  | 'symptom';

export interface ExtractedFact {
  kind: FactKind;
  value: string;
  confidence: number;
  /** true when the person is retracting or correcting a prior claim */
  negates?: boolean;
}

export interface StoredFact {
  id: string;
  kind: FactKind;
  value: string;
  status: 'active' | 'superseded' | 'retracted';
  supersedes_id: string | null;
  confidence: number | null;
  created_at: string;
}

const VALID_KINDS: FactKind[] = [
  'chief_complaint',
  'medication',
  'allergy',
  'condition',
  'symptom',
];

/* ---------------------------------------------------------------
 * Extraction
 * --------------------------------------------------------------- */

const EXTRACTION_SYSTEM = `You extract structured clinical facts from a person's message for a clinic intake record.

You do NOT diagnose. You do NOT infer conditions the person did not state. You only record what they actually said.

Return JSON only, in this exact shape:
{"facts":[{"kind":"...","value":"...","confidence":0.0,"negates":false}]}

kind must be one of: chief_complaint, medication, allergy, condition, symptom

RULES:
- value must be short (under 60 characters) and in the person's own terms.
- confidence: 1.0 if stated plainly, lower if implied or vague.
- negates: true ONLY when the person is retracting or denying something
  previously believed (e.g. "actually I'm not allergic to penicillin",
  "I stopped taking metformin"). Otherwise false.
- Do NOT record placeholder tokens like [NAME] or [PHONE] as facts.
- If the message contains no clinical facts, return {"facts":[]}.
- Never invent a medication dose, a diagnosis, or a duration that was
  not stated.`;

export async function extractFacts(
  redactedText: string
): Promise<ExtractedFact[]> {
  const res = await completeOrNull({
    tier: 'fast',
    json: true,
    maxTokens: 500,
    system: EXTRACTION_SYSTEM,
    prompt: `Message from person: ${redactedText}`,
  });

  if (!res?.parsed) return [];

  const raw = (res.parsed as { facts?: unknown }).facts;
  if (!Array.isArray(raw)) return [];

  const out: ExtractedFact[] = [];
  for (const f of raw) {
    const item = f as Record<string, unknown>;
    const kind = item.kind as FactKind;
    const value = typeof item.value === 'string' ? item.value.trim() : '';

    // Reject anything malformed rather than storing junk in a
    // clinical record.
    if (!VALID_KINDS.includes(kind)) continue;
    if (!value || value.length > 120) continue;
    if (/^\[[A-Z_]+\]$/.test(value)) continue; // redaction placeholder

    out.push({
      kind,
      value,
      confidence:
        typeof item.confidence === 'number'
          ? Math.max(0, Math.min(1, item.confidence))
          : 0.5,
      negates: item.negates === true,
    });
  }
  return out;
}

/* ---------------------------------------------------------------
 * Persistence with provenance
 * --------------------------------------------------------------- */

function similar(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  // one contains the other (e.g. "penicillin" vs "allergic to penicillin")
  return x.length > 3 && y.length > 3 && (x.includes(y) || y.includes(x));
}

/**
 * Write extracted facts, handling supersession.
 *
 * @param messageId the message these facts came from — REQUIRED,
 *                  because a fact without provenance is not stored.
 */
export async function applyFacts(params: {
  clinicId: string;
  sessionId: string;
  messageId: string;
  facts: ExtractedFact[];
}): Promise<StoredFact[]> {
  const { clinicId, sessionId, messageId, facts } = params;
  if (!messageId) throw new Error('applyFacts: messageId is required (provenance)');
  if (facts.length === 0) return [];

  const db = serviceClient();

  const { data: existing } = await db
    .from('profile_facts')
    .select('id, kind, value, status, supersedes_id, confidence, created_at')
    .eq('session_id', sessionId)
    .eq('status', 'active');

  const active = (existing ?? []) as StoredFact[];
  const written: StoredFact[] = [];

  for (const f of facts) {
    const prior = active.find(
      (a) => a.kind === f.kind && similar(a.value, f.value)
    );

    // Retraction: mark the old fact retracted, record the correction.
    if (f.negates) {
      if (!prior) continue; // nothing to retract
      await db
        .from('profile_facts')
        .update({ status: 'retracted', superseded_at: new Date().toISOString() })
        .eq('id', prior.id);

      const { data: correction } = await db
        .from('profile_facts')
        .insert({
          clinic_id: clinicId,
          session_id: sessionId,
          kind: f.kind,
          value: `NOT: ${f.value}`,
          status: 'active',
          supersedes_id: prior.id,
          confidence: f.confidence,
        })
        .select('id, kind, value, status, supersedes_id, confidence, created_at')
        .single();

      if (correction) {
        await db.from('fact_citations').insert({
          clinic_id: clinicId,
          fact_id: correction.id,
          message_id: messageId,
        });
        written.push(correction as StoredFact);
      }
      continue;
    }

    // Duplicate of an existing active fact — cite the new message as
    // additional support rather than creating a second row.
    if (prior && prior.value.toLowerCase() === f.value.toLowerCase()) {
      await db
        .from('fact_citations')
        .insert({
          clinic_id: clinicId,
          fact_id: prior.id,
          message_id: messageId,
        })
        .select()
        .maybeSingle();
      continue;
    }

    // Refinement of an existing fact: supersede it.
    if (prior) {
      await db
        .from('profile_facts')
        .update({
          status: 'superseded',
          superseded_at: new Date().toISOString(),
        })
        .eq('id', prior.id);
    }

    const { data: created, error } = await db
      .from('profile_facts')
      .insert({
        clinic_id: clinicId,
        session_id: sessionId,
        kind: f.kind,
        value: f.value,
        status: 'active',
        supersedes_id: prior?.id ?? null,
        confidence: f.confidence,
      })
      .select('id, kind, value, status, supersedes_id, confidence, created_at')
      .single();

    if (error || !created) continue;

    // PROVENANCE — written immediately, never deferred.
    const { error: citeErr } = await db.from('fact_citations').insert({
      clinic_id: clinicId,
      fact_id: created.id,
      message_id: messageId,
    });

    // If the citation fails, the fact loses its provenance guarantee,
    // so we remove it rather than keep an unsourced clinical claim.
    if (citeErr) {
      await db.from('profile_facts').delete().eq('id', created.id);
      continue;
    }

    written.push(created as StoredFact);
  }

  return written;
}

/* ---------------------------------------------------------------
 * Reading the profile
 * --------------------------------------------------------------- */

export interface ProfileFactWithProvenance extends StoredFact {
  citations: Array<{
    message_id: string;
    body_raw: string;
    created_at: string;
  }>;
}

/**
 * The clinician-facing profile: active facts, each with the source
 * messages that support it.
 */
export async function getProfile(
  sessionId: string
): Promise<ProfileFactWithProvenance[]> {
  const db = serviceClient();

  const { data: facts } = await db
    .from('profile_facts')
    .select('id, kind, value, status, supersedes_id, confidence, created_at')
    .eq('session_id', sessionId)
    .eq('status', 'active')
    .order('created_at', { ascending: true });

  if (!facts?.length) return [];

  const { data: cites } = await db
    .from('fact_citations')
    .select('fact_id, message_id, messages(body_raw, created_at)')
    .in(
      'fact_id',
      facts.map((f) => f.id)
    );

  return facts.map((f) => ({
    ...(f as StoredFact),
    citations: (cites ?? [])
      .filter((c) => c.fact_id === f.id)
      .map((c) => {
        const m = c.messages as unknown as {
          body_raw: string;
          created_at: string;
        } | null;
        return {
          message_id: c.message_id as string,
          body_raw: m?.body_raw ?? '',
          created_at: m?.created_at ?? '',
        };
      }),
  }));
}

/**
 * Compact profile summary for model context.
 * This is the cost lever: we send this instead of the full transcript,
 * so token usage stays flat as a conversation grows.
 */
export async function getProfileSummary(sessionId: string): Promise<string> {
  const facts = await getProfile(sessionId);
  if (!facts.length) return '(no recorded history)';

  const grouped: Record<string, string[]> = {};
  for (const f of facts) {
    (grouped[f.kind] ??= []).push(f.value);
  }

  return Object.entries(grouped)
    .map(([kind, values]) => `${kind.replace('_', ' ')}: ${values.join(', ')}`)
    .join('\n');
}
