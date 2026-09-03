/**
 * Trust transition: guest -> patient
 * ---------------------------------------------------------------
 * The brief's "earned identity" step. A person talks to the system
 * anonymously, receives value, and only then is asked to identify
 * themselves.
 *
 * THE CRITICAL PROPERTY: conversion must not orphan history. The
 * session row is UPDATED in place rather than a new one created, so
 * every message, fact, citation, risk assessment and escalation
 * already attached to it stays attached. Nothing is copied, so
 * nothing can be copied incorrectly, and the provenance chain
 * survives the transition intact.
 *
 * Auth is magic-link: no password to store, forget, or reuse. In a
 * health context that is one fewer credential to leak.
 */

import 'server-only';
import { serviceClient } from './supabase';
import type { ValueEventKind } from './guest-value';

export { buildVisitPrepChecklist, type ValueEventKind } from './guest-value';

export interface ConversionResult {
  ok: boolean;
  error?: string;
  /** counts preserved through the transition, for verification */
  preserved?: {
    messages: number;
    facts: number;
    riskAssessments: number;
    escalations: number;
  };
}

/**
 * Attach an authenticated user to an existing guest session.
 *
 * Idempotent: calling twice with the same user is a no-op rather
 * than an error, because a person clicking a magic link twice is
 * ordinary behaviour, not a fault.
 */
export async function convertGuestToPatient(params: {
  sessionId: string;
  authUserId: string;
}): Promise<ConversionResult> {
  const db = serviceClient();

  const { data: session, error: readErr } = await db
    .from('sessions')
    .select('id, clinic_id, kind, auth_user_id, deleted_at')
    .eq('id', params.sessionId)
    .single();

  if (readErr || !session) {
    return { ok: false, error: 'Session not found' };
  }

  if (session.deleted_at) {
    return { ok: false, error: 'Session has been deleted' };
  }

  // Already converted — check it is the same person.
  if (session.auth_user_id) {
    if (session.auth_user_id === params.authUserId) {
      return { ok: true, preserved: await countAttached(params.sessionId) };
    }
    // A different user trying to claim someone else's session. This
    // is the shared-device risk named in the brief; refuse rather
    // than reassign.
    return {
      ok: false,
      error: 'This conversation is already linked to another account',
    };
  }

  const { error: updateErr } = await db
    .from('sessions')
    .update({
      kind: 'patient',
      auth_user_id: params.authUserId,
      converted_at: new Date().toISOString(),
    })
    .eq('id', params.sessionId);

  if (updateErr) {
    return { ok: false, error: updateErr.message };
  }

  await db.from('funnel_events').insert({
    clinic_id: session.clinic_id,
    session_id: params.sessionId,
    step: 'converted',
  });

  // PHI-free: records that a conversion happened, not who or what.
  await db.from('audit_logs').insert({
    clinic_id: session.clinic_id,
    actor_role: 'patient',
    action: 'guest_converted_to_patient',
    subject_table: 'sessions',
    subject_id: params.sessionId,
    meta: {},
  });

  return { ok: true, preserved: await countAttached(params.sessionId) };
}

/**
 * Count the records still attached after conversion. Used by
 * test_guest_to_patient_conversion to prove nothing was orphaned.
 */
export async function countAttached(sessionId: string) {
  const db = serviceClient();

  const [m, f, r, e] = await Promise.all([
    db.from('messages').select('id', { count: 'exact', head: true }).eq('session_id', sessionId),
    db.from('profile_facts').select('id', { count: 'exact', head: true }).eq('session_id', sessionId),
    db.from('risk_assessments').select('id', { count: 'exact', head: true }).eq('session_id', sessionId),
    db.from('escalations').select('id', { count: 'exact', head: true }).eq('session_id', sessionId),
  ]);

  return {
    messages: m.count ?? 0,
    facts: f.count ?? 0,
    riskAssessments: r.count ?? 0,
    escalations: e.count ?? 0,
  };
}

/* ---------------------------------------------------------------
 * Guest value — delivered BEFORE identity is requested
 * ---------------------------------------------------------------
 * The brief asks for non-diagnostic value up front. These are
 * deliberately not medical: a visit preparation checklist and
 * practical clinic information. Nothing here assesses the person's
 * condition, because that would cross the line the whole system is
 * built to respect.
 */

export async function recordValueEvent(params: {
  clinicId: string;
  sessionId: string;
  kind: ValueEventKind;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const db = serviceClient();

  await db.from('value_events').insert({
    clinic_id: params.clinicId,
    session_id: params.sessionId,
    kind: params.kind,
    payload: params.payload ?? {},
  });

  await db.from('funnel_events').insert({
    clinic_id: params.clinicId,
    session_id: params.sessionId,
    step: 'value_delivered',
  });
}

