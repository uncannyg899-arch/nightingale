/**
 * Clinician data layer
 * ---------------------------------------------------------------
 * Reads for the staff-facing view: the escalation queue, the warm
 * lead list, and the actions a clinician can take on a case.
 *
 * NOTE ON ACCESS CONTROL: these functions use the service client and
 * therefore bypass row-level security. That is deliberate — they are
 * only ever called from server routes that have already established
 * the caller is clinic staff. RLS remains the enforcement layer for
 * anything reaching the browser directly; this is the trusted path,
 * and it is trusted precisely because it never runs client-side.
 *
 * The one action that is NOT trusted to this layer is clearing an
 * escalation: a Postgres trigger independently verifies the actor is
 * a clinician, so a bug here cannot let staff clear a high-risk flag.
 */

import 'server-only';
import { serviceClient } from './supabase';

export interface QueueItem {
  id: string;
  sessionId: string;
  level: 'low' | 'medium' | 'high';
  state: 'pending' | 'acknowledged' | 'resolved' | 'auto_fallback';
  afterHours: boolean;
  createdAt: string;
  ackDeadline: string | null;
  acknowledgedAt: string | null;
  clearedAt: string | null;
  clinicallyAppropriate: boolean | null;
  /** true when the acknowledgement SLA has lapsed unacknowledged */
  breachedSla: boolean;
  reasons: string;
  ruleHits: string[];
  /** the message that triggered this, for context */
  triggerMessage: string;
}

export interface LeadItem {
  sessionId: string;
  channel: string;
  channelRef: string | null;
  kind: 'lead' | 'patient';
  firstTouchAt: string;
  convertedAt: string | null;
  messageCount: number;
  factCount: number;
  highestRisk: 'low' | 'medium' | 'high';
  lastMessageAt: string | null;
}

/* ---------------------------------------------------------------
 * Escalation queue
 * --------------------------------------------------------------- */

export async function getEscalationQueue(
  clinicId: string
): Promise<QueueItem[]> {
  const db = serviceClient();

  const { data, error } = await db
    .from('escalations')
    .select(
      `id, session_id, level, state, after_hours, created_at,
       ack_deadline, acknowledged_at, cleared_at, clinically_appropriate,
       risk_assessments ( rationale, rule_hits, message_id )`
    )
    .eq('clinic_id', clinicId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error || !data) return [];

  // Fetch trigger messages in one round trip rather than N.
  const messageIds = data
    .map((e) => {
      const ra = e.risk_assessments as unknown as { message_id?: string } | null;
      return ra?.message_id;
    })
    .filter((id): id is string => Boolean(id));

  const messageMap = new Map<string, string>();
  if (messageIds.length) {
    const { data: msgs } = await db
      .from('messages')
      .select('id, body_raw')
      .in('id', messageIds);
    for (const m of msgs ?? []) messageMap.set(m.id, m.body_raw);
  }

  const now = Date.now();

  return data.map((e) => {
    const ra = e.risk_assessments as unknown as {
      rationale?: string;
      rule_hits?: string[];
      message_id?: string;
    } | null;

    const deadline = e.ack_deadline ? new Date(e.ack_deadline).getTime() : null;

    return {
      id: e.id as string,
      sessionId: e.session_id as string,
      level: e.level as QueueItem['level'],
      state: e.state as QueueItem['state'],
      afterHours: Boolean(e.after_hours),
      createdAt: e.created_at as string,
      ackDeadline: (e.ack_deadline as string) ?? null,
      acknowledgedAt: (e.acknowledged_at as string) ?? null,
      clearedAt: (e.cleared_at as string) ?? null,
      clinicallyAppropriate: e.clinically_appropriate as boolean | null,
      breachedSla:
        !e.acknowledged_at && deadline !== null && now > deadline,
      reasons: ra?.rationale ?? '',
      ruleHits: ra?.rule_hits ?? [],
      triggerMessage: ra?.message_id
        ? (messageMap.get(ra.message_id) ?? '')
        : '',
    };
  });
}

/* ---------------------------------------------------------------
 * Warm leads
 * --------------------------------------------------------------- */

export async function getLeads(clinicId: string): Promise<LeadItem[]> {
  const db = serviceClient();

  const { data: sessions } = await db
    .from('sessions')
    .select('id, kind, channel, channel_ref, first_touch_at, converted_at')
    .eq('clinic_id', clinicId)
    .is('deleted_at', null)
    .order('first_touch_at', { ascending: false })
    .limit(50);

  if (!sessions?.length) return [];

  const ids = sessions.map((s) => s.id as string);

  const [{ data: msgs }, { data: facts }, { data: risks }] = await Promise.all([
    db.from('messages').select('session_id, created_at').in('session_id', ids),
    db
      .from('profile_facts')
      .select('session_id')
      .in('session_id', ids)
      .eq('status', 'active'),
    db.from('risk_assessments').select('session_id, level').in('session_id', ids),
  ]);

  const order = { low: 0, medium: 1, high: 2 } as const;

  return sessions.map((s) => {
    const sid = s.id as string;
    const sessionMsgs = (msgs ?? []).filter((m) => m.session_id === sid);
    const sessionRisks = (risks ?? []).filter((r) => r.session_id === sid);

    let highest: LeadItem['highestRisk'] = 'low';
    for (const r of sessionRisks) {
      const lvl = r.level as LeadItem['highestRisk'];
      if (order[lvl] > order[highest]) highest = lvl;
    }

    const lastMessageAt = sessionMsgs
      .map((m) => m.created_at as string)
      .sort()
      .pop();

    return {
      sessionId: sid,
      channel: s.channel as string,
      channelRef: (s.channel_ref as string) ?? null,
      kind: s.kind as LeadItem['kind'],
      firstTouchAt: s.first_touch_at as string,
      convertedAt: (s.converted_at as string) ?? null,
      messageCount: sessionMsgs.length,
      factCount: (facts ?? []).filter((f) => f.session_id === sid).length,
      highestRisk: highest,
      lastMessageAt: lastMessageAt ?? null,
    };
  });
}

/* ---------------------------------------------------------------
 * Funnel counts (per channel)
 * --------------------------------------------------------------- */

export async function getFunnelSummary(
  clinicId: string
): Promise<Record<string, Record<string, number>>> {
  const db = serviceClient();

  const { data } = await db
    .from('sessions')
    .select('channel, kind')
    .eq('clinic_id', clinicId)
    .is('deleted_at', null);

  const out: Record<string, Record<string, number>> = {};
  for (const s of data ?? []) {
    const ch = s.channel as string;
    out[ch] ??= { leads: 0, converted: 0 };
    out[ch].leads += 1;
    if (s.kind === 'patient') out[ch].converted += 1;
  }
  return out;
}

/* ---------------------------------------------------------------
 * Actions
 * --------------------------------------------------------------- */

export async function acknowledgeEscalation(params: {
  escalationId: string;
  memberId: string;
}): Promise<{ ok: boolean; error?: string }> {
  const db = serviceClient();

  const { error } = await db
    .from('escalations')
    .update({
      state: 'acknowledged',
      acknowledged_at: new Date().toISOString(),
      acknowledged_by: params.memberId,
    })
    .eq('id', params.escalationId);

  if (error) return { ok: false, error: error.message };

  await db.from('audit_logs').insert({
    clinic_id: await clinicIdFor(params.escalationId),
    actor_role: 'clinician',
    actor_id: params.memberId,
    action: 'escalation_acknowledged',
    subject_table: 'escalations',
    subject_id: params.escalationId,
    meta: {},
  });

  return { ok: true };
}

/**
 * Clear an escalation and record whether it was clinically warranted.
 *
 * The `clinicallyAppropriate` flag is the over-escalation metric: it
 * is what separates "this system escalates often" from "this system
 * escalates well". Without it, a false-positive high looks identical
 * to a true one in every report the clinic ever runs.
 *
 * A Postgres trigger independently rejects this if the actor is not a
 * clinician, so staff cannot clear a flag even if this code is wrong.
 */
export async function clearEscalation(params: {
  escalationId: string;
  memberId: string;
  clinicallyAppropriate: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  const db = serviceClient();

  const { error } = await db
    .from('escalations')
    .update({
      state: 'resolved',
      cleared_at: new Date().toISOString(),
      cleared_by: params.memberId,
      clinically_appropriate: params.clinicallyAppropriate,
    })
    .eq('id', params.escalationId);

  if (error) {
    // The trigger message is the useful one — surface it as-is.
    return { ok: false, error: error.message };
  }

  await db.from('audit_logs').insert({
    clinic_id: await clinicIdFor(params.escalationId),
    actor_role: 'clinician',
    actor_id: params.memberId,
    action: 'escalation_cleared',
    subject_table: 'escalations',
    subject_id: params.escalationId,
    meta: { clinically_appropriate: params.clinicallyAppropriate },
  });

  return { ok: true };
}

async function clinicIdFor(escalationId: string): Promise<string> {
  const db = serviceClient();
  const { data } = await db
    .from('escalations')
    .select('clinic_id')
    .eq('id', escalationId)
    .single();
  return (data?.clinic_id as string) ?? '';
}

/* ---------------------------------------------------------------
 * Over-escalation metric
 * --------------------------------------------------------------- */

export interface EscalationQuality {
  totalCleared: number;
  appropriate: number;
  inappropriate: number;
  /** proportion of cleared escalations a clinician judged warranted */
  appropriateRate: number | null;
}

export async function getEscalationQuality(
  clinicId: string
): Promise<EscalationQuality> {
  const db = serviceClient();

  const { data } = await db
    .from('escalations')
    .select('clinically_appropriate')
    .eq('clinic_id', clinicId)
    .not('clinically_appropriate', 'is', null);

  const rows = data ?? [];
  const appropriate = rows.filter((r) => r.clinically_appropriate).length;
  const total = rows.length;

  return {
    totalCleared: total,
    appropriate,
    inappropriate: total - appropriate,
    appropriateRate: total > 0 ? appropriate / total : null,
  };
}
