/**
 * Intake Pipeline
 * ---------------------------------------------------------------
 * The order of operations here IS the safety design. Reading top to
 * bottom is meant to make the guarantees obvious:
 *
 *   1. Risk assess on RAW text     (clinical signal intact)
 *   2. Redact                       (PHI removed)
 *   3. Persist both versions        (raw for clinicians, redacted for models)
 *   4. Escalate if HIGH             (before any reply is generated)
 *   5. Only then talk to a model    (and only with redacted text)
 *
 * Step 1 before step 2 is deliberate: redacting first would strip
 * "Encik Ahmad has chest pain" down to "[NAME] has chest pain", which
 * is fine — but redacting a message like "my son Adam, 3, can't
 * breathe" could remove age/context the rules use. We assess first,
 * redact second, and never let raw text past step 3.
 *
 * Step 4 before step 5 matters too: a HIGH-risk patient gets an
 * escalation recorded even if the LLM is down, rate-limited, or slow.
 * Safety must not depend on a third-party API being up.
 */

import 'server-only';
import { serviceClient } from './supabase';
import { redact } from './redaction';
import {
  assessDeterministic,
  combineWithModel,
  type RiskLevel,
  type RiskResult,
} from './risk';
import { completeOrNull } from './llm';
import { extractFacts, applyFacts } from './memory';

export interface IntakeInput {
  clinicId: string;
  sessionId: string;
  text: string;
}

export interface IntakeOutput {
  riskLevel: RiskLevel;
  halt: boolean;
  reply: string;
  escalationId?: string;
  afterHours: boolean;
  emergencyNumber: string;
  reasons: string[];
}

/* ---------------------------------------------------------------
 * Model-assisted second opinion on risk.
 * Note it receives REDACTED text only, and is asked for a bare
 * label — no free-text advice, because its output never reaches
 * the patient on this path.
 * --------------------------------------------------------------- */
async function modelRiskOpinion(redactedText: string): Promise<RiskLevel | null> {
  const res = await completeOrNull({
    tier: 'fast',
    json: true,
    maxTokens: 100,
    system:
      'You are a triage classifier for a clinic intake system in Malaysia. ' +
      'You do NOT diagnose and you do NOT give advice. You output only a ' +
      'risk label. Respond with JSON: {"level":"low"|"medium"|"high"}. ' +
      'Use "high" for anything suggesting a medical emergency requiring ' +
      'immediate care. Use "medium" for urgent but non-emergency concerns. ' +
      'Use "low" for routine enquiries. When uncertain, choose the HIGHER level.',
    prompt: `Message from person: ${redactedText}`,
  });

  if (!res?.parsed) return null;
  const level = (res.parsed as { level?: string }).level;
  return level === 'high' || level === 'medium' || level === 'low'
    ? (level as RiskLevel)
    : null;
}

/* ---------------------------------------------------------------
 * Empathetic, non-diagnostic reply for low/medium risk.
 * The system prompt does the regulatory work: no condition names,
 * no treatment suggestions, no reassurance about severity.
 * --------------------------------------------------------------- */
async function generateReply(
  redactedText: string,
  level: RiskLevel
): Promise<string> {
  const res = await completeOrNull({
    tier: 'chat',
    maxTokens: 300,
    system:
      'You are an intake assistant for a Malaysian clinic. You are NOT a ' +
      'doctor and you must never behave like one.\n\n' +
      'ABSOLUTE RULES:\n' +
      '- Never name or suggest a diagnosis or condition.\n' +
      '- Never recommend, adjust, or comment on any treatment or medication.\n' +
      '- Never tell the patient their symptoms are minor, harmless, or ' +
      '"probably nothing" — that is a clinical judgement you cannot make.\n' +
      '- Never promise a waiting time or outcome.\n' +
      '- If asked whether you are human, say plainly that you are an AI ' +
      'assistant.\n\n' +
      'WHAT YOU DO: acknowledge what the person said with warmth, ask at ' +
      'most one clarifying question that would help a clinician, and ' +
      'explain the next step in getting seen. Keep it under 80 words. ' +
      'Plain language, no jargon.',
    prompt:
      `Message from person: ${redactedText}\n` +
      `Assessed urgency (internal, do not state it as a medical opinion): ${level}`,
  });

  if (res?.text) return res.text.trim();

  // Deterministic fallback — the system stays usable without the model.
  return level === 'medium'
    ? "Thanks for telling us. Based on what you've shared, we'd like a member of the clinic team to review this soon. Could you tell us when this started?"
    : 'Thanks for reaching out. A member of our team will follow up. Could you share a little more about what you are experiencing?';
}

/* ---------------------------------------------------------------
 * After-hours check. Drives whether a HIGH-risk patient is told to
 * wait for a callback (bad) or to call emergency services directly
 * (correct when nobody is watching the queue).
 * --------------------------------------------------------------- */
function isAfterHours(
  nowUtc: Date,
  open: string,
  close: string,
  timezone: string
): boolean {
  const local = new Date(
    nowUtc.toLocaleString('en-US', { timeZone: timezone })
  );
  const mins = local.getHours() * 60 + local.getMinutes();
  const [oh, om] = open.split(':').map(Number);
  const [ch, cm] = close.split(':').map(Number);
  return mins < oh * 60 + om || mins >= ch * 60 + cm;
}

/* ---------------------------------------------------------------
 * Main entry point.
 * --------------------------------------------------------------- */
export async function processIntakeMessage(
  input: IntakeInput
): Promise<IntakeOutput> {
  const db = serviceClient();

  // --- clinic config (emergency number, hours, SLA) ---
  const { data: clinic, error: clinicErr } = await db
    .from('clinics')
    .select('id, emergency_number, timezone, office_open, office_close, ack_sla_minutes')
    .eq('id', input.clinicId)
    .single();

  if (clinicErr || !clinic) {
    throw new Error(`Unknown clinic: ${input.clinicId}`);
  }

  // --- 1. RISK ON RAW TEXT ---
  const deterministic: RiskResult = assessDeterministic(input.text);

  // --- 2. REDACT ---
  const { redacted, redactions } = redact(input.text);

  // --- 3. PERSIST ---
  const { data: message, error: msgErr } = await db
    .from('messages')
    .insert({
      clinic_id: input.clinicId,
      session_id: input.sessionId,
      author_role: 'guest',
      body_raw: input.text,
      body_redacted: redacted,
      redactions,
    })
    .select('id')
    .single();

  if (msgErr) throw new Error(`Failed to store message: ${msgErr.message}`);

  // --- model second opinion (can only raise the level) ---
  const modelLevel = await modelRiskOpinion(redacted);
  const risk = combineWithModel(deterministic, modelLevel);

  // --- record the assessment (DB trigger blocks any downgrade) ---
  const { data: assessment, error: raErr } = await db
    .from('risk_assessments')
    .insert({
      clinic_id: input.clinicId,
      session_id: input.sessionId,
      message_id: message.id,
      level: risk.level,
      mts: risk.mts,
      rule_hits: risk.ruleHits,
      model_level: modelLevel,
      rationale: risk.reasons.join('; '),
    })
    .select('id')
    .single();

  // A downgrade attempt raises inside Postgres. That is the one-way
  // lock working as intended — treat it as "risk stays high", not
  // as a failure.
  if (raErr && !/risk downgrade blocked/i.test(raErr.message)) {
    throw new Error(`Failed to record risk: ${raErr.message}`);
  }

  const afterHours = isAfterHours(
    new Date(),
    clinic.office_open,
    clinic.office_close,
    clinic.timezone
  );

  // --- 4. ESCALATE BEFORE REPLYING ---
  let escalationId: string | undefined;
  if (risk.halt && assessment) {
    const created = new Date();
    const deadline = new Date(
      created.getTime() + clinic.ack_sla_minutes * 60_000
    );

    const { data: esc } = await db
      .from('escalations')
      .insert({
        clinic_id: input.clinicId,
        session_id: input.sessionId,
        risk_assessment_id: assessment.id,
        level: risk.level,
        state: afterHours ? 'auto_fallback' : 'pending',
        after_hours: afterHours,
        ack_deadline: deadline.toISOString(),
      })
      .select('id')
      .single();

    escalationId = esc?.id;
  }

  // --- LIVING MEMORY ---
  // Runs AFTER escalation on purpose: extracting facts must never
  // delay an emergency response. If extraction fails, the escalation
  // has already happened.
  try {
    const facts = await extractFacts(redacted);
    if (facts.length) {
      await applyFacts({
        clinicId: input.clinicId,
        sessionId: input.sessionId,
        messageId: message.id,
        facts,
      });
    }
  } catch (err) {
    console.error('[memory] extraction failed:', (err as Error).message);
  }

  // PHI-free audit entry: identifiers only, never content.
  await db.from('audit_logs').insert({
    clinic_id: input.clinicId,
    actor_role: 'system',
    action: 'intake_message_processed',
    subject_table: 'messages',
    subject_id: message.id,
    meta: {
      risk_level: risk.level,
      rule_hits: risk.ruleHits,
      redaction_count: redactions.length,
      escalated: Boolean(escalationId),
    },
  });

  // --- 5. REPLY ---
  // HIGH risk halts the assistant entirely. No model call, no advice,
  // no conversation — a fixed, deterministic safety message.
  if (risk.halt) {
    const reply = afterHours
      ? `Based on what you've described, this needs urgent medical attention right now. Please call ${clinic.emergency_number} immediately or go to your nearest emergency department. Our clinic is currently closed, so please do not wait for us to reply.`
      : `Based on what you've described, this needs urgent medical attention. Please call ${clinic.emergency_number} now or go to your nearest emergency department. We have alerted our clinical team, but please do not wait for a reply before seeking help.`;

    return {
      riskLevel: risk.level,
      halt: true,
      reply,
      escalationId,
      afterHours,
      emergencyNumber: clinic.emergency_number,
      reasons: risk.reasons,
    };
  }

  const reply = await generateReply(redacted, risk.level);

  await db.from('messages').insert({
    clinic_id: input.clinicId,
    session_id: input.sessionId,
    author_role: 'system',
    body_raw: reply,
    body_redacted: reply,
    redactions: [],
  });

  return {
    riskLevel: risk.level,
    halt: false,
    reply,
    afterHours,
    emergencyNumber: clinic.emergency_number,
    reasons: risk.reasons,
  };
}
