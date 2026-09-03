'use client';

import { useState, useEffect, useCallback } from 'react';

const CLINIC_ID = '11111111-1111-1111-1111-111111111111';
// Stand-in for the authenticated clinician. See brief §10 — auth is
// designed in the schema but not implemented.
const MEMBER_ID = null;

interface QueueItem {
  id: string;
  sessionId: string;
  level: 'low' | 'medium' | 'high';
  state: string;
  afterHours: boolean;
  createdAt: string;
  acknowledgedAt: string | null;
  clearedAt: string | null;
  clinicallyAppropriate: boolean | null;
  breachedSla: boolean;
  reasons: string;
  ruleHits: string[];
  triggerMessage: string;
}

interface LeadItem {
  sessionId: string;
  channel: string;
  kind: string;
  firstTouchAt: string;
  messageCount: number;
  factCount: number;
  highestRisk: 'low' | 'medium' | 'high';
  lastMessageAt: string | null;
}

interface Quality {
  totalCleared: number;
  appropriate: number;
  inappropriate: number;
  appropriateRate: number | null;
}

function ago(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function Clinician() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [leads, setLeads] = useState<LeadItem[]>([]);
  const [funnel, setFunnel] = useState<Record<string, Record<string, number>>>({});
  const [quality, setQuality] = useState<Quality | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'queue' | 'leads'>('queue');
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/clinician?clinicId=${CLINIC_ID}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? 'Failed to load');
      setQueue(d.queue ?? []);
      setLeads(d.leads ?? []);
      setFunnel(d.funnel ?? {});
      setQuality(d.quality ?? null);
      setNote(null);
    } catch (err) {
      setNote('Could not load the queue. Refresh to try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  async function act(
    escalationId: string,
    action: 'acknowledge' | 'clear',
    clinicallyAppropriate?: boolean
  ) {
    if (!MEMBER_ID) {
      setNote(
        'Actions need an authenticated clinician account. Auth is designed in the schema but not built — see brief §10.'
      );
      return;
    }
    const r = await fetch('/api/clinician', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        escalationId,
        memberId: MEMBER_ID,
        clinicallyAppropriate,
      }),
    });
    const d = await r.json();
    if (!d.ok) setNote(d.error ?? 'Action failed');
    load();
  }

  const open = queue.filter((q) => !q.clearedAt);
  const pct =
    quality?.appropriateRate !== null && quality?.appropriateRate !== undefined
      ? Math.round(quality.appropriateRate * 100)
      : null;

  return (
    <div className="min-h-screen bg-[#0C1116] text-[#E4E9ED]">
      <div className="mx-auto max-w-6xl px-5 py-7">
        <header className="mb-7 flex items-baseline justify-between border-b border-[#1E2830] pb-4">
          <div>
            <h1 className="text-xl font-semibold">Klinik Nightingale</h1>
            <p className="mt-0.5 text-sm text-[#7C8A96]">
              Clinical queue and lead activity
            </p>
          </div>
          <div className="text-right text-sm">
            <p className="text-[#7C8A96]">Open escalations</p>
            <p className="text-2xl font-semibold tabular-nums">{open.length}</p>
          </div>
        </header>

        {note && (
          <p className="mb-5 rounded border border-[#2E3A44] bg-[#141C23] px-4 py-3 text-sm text-[#A9B6C1]">
            {note}
          </p>
        )}

        {/* over-escalation metric */}
        <section className="mb-7 rounded border border-[#1E2830] bg-[#111820] p-4">
          <h2 className="text-sm font-medium">Escalation quality</h2>
          <p className="mt-1 text-sm text-[#7C8A96]">
            Of escalations a clinician has closed, the share judged
            clinically warranted. This is what separates escalating often
            from escalating well.
          </p>
          {quality && quality.totalCleared > 0 ? (
            <div className="mt-3 flex items-baseline gap-6">
              <p className="text-3xl font-semibold tabular-nums">{pct}%</p>
              <p className="text-sm text-[#7C8A96]">
                {quality.appropriate} warranted · {quality.inappropriate} not ·{' '}
                {quality.totalCleared} reviewed
              </p>
            </div>
          ) : (
            <p className="mt-3 text-sm text-[#5F6D79]">
              No escalations reviewed yet. The rate appears once a clinician
              closes a case.
            </p>
          )}
        </section>

        <nav className="mb-4 flex gap-1 border-b border-[#1E2830]">
          {(['queue', 'leads'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={
                tab === t
                  ? 'border-b-2 border-[#4EA3C4] px-4 py-2 text-sm font-medium'
                  : 'px-4 py-2 text-sm text-[#7C8A96] hover:text-[#E4E9ED]'
              }
            >
              {t === 'queue' ? 'Escalations' : 'Leads'}
            </button>
          ))}
        </nav>

        {loading ? (
          <p className="py-10 text-sm text-[#5F6D79]">Loading…</p>
        ) : tab === 'queue' ? (
          queue.length === 0 ? (
            <p className="py-10 text-sm text-[#5F6D79]">
              No escalations. High-risk intake messages appear here the moment
              they are flagged.
            </p>
          ) : (
            <ul className="space-y-3">
              {queue.map((q) => (
                <li
                  key={q.id}
                  className={
                    q.clearedAt
                      ? 'rounded border border-[#1E2830] bg-[#0F151B] p-4 opacity-60'
                      : q.level === 'high'
                        ? 'rounded border-l-4 border-l-[#C1272D] border-y border-r border-[#1E2830] bg-[#141017] p-4'
                        : 'rounded border-l-4 border-l-[#C4913E] border-y border-r border-[#1E2830] bg-[#141210] p-4'
                  }
                >
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="text-sm font-semibold uppercase tracking-wide">
                      {q.level}
                    </span>
                    <span className="text-sm text-[#7C8A96]">
                      {ago(q.createdAt)}
                    </span>
                    {q.afterHours && (
                      <span className="rounded bg-[#1E2830] px-2 py-0.5 text-xs">
                        after hours — patient sent to emergency services
                      </span>
                    )}
                    {q.breachedSla && !q.clearedAt && (
                      <span className="rounded bg-[#3A1518] px-2 py-0.5 text-xs text-[#FF8A8A]">
                        acknowledgement overdue
                      </span>
                    )}
                    {q.clearedAt && (
                      <span className="text-xs text-[#7C8A96]">
                        closed ·{' '}
                        {q.clinicallyAppropriate ? 'warranted' : 'not warranted'}
                      </span>
                    )}
                  </div>

                  {q.triggerMessage && (
                    <p className="mt-3 border-l-2 border-[#2E3A44] pl-3 text-sm italic text-[#A9B6C1]">
                      “{q.triggerMessage}”
                    </p>
                  )}

                  {q.reasons && (
                    <p className="mt-2 text-sm text-[#7C8A96]">{q.reasons}</p>
                  )}

                  {!q.clearedAt && (
                    <div className="mt-4 flex flex-wrap gap-2">
                      {!q.acknowledgedAt && (
                        <button
                          onClick={() => act(q.id, 'acknowledge')}
                          className="rounded bg-[#1E2830] px-3 py-1.5 text-sm hover:bg-[#26333D]"
                        >
                          Acknowledge
                        </button>
                      )}
                      <button
                        onClick={() => act(q.id, 'clear', true)}
                        className="rounded bg-[#1E2830] px-3 py-1.5 text-sm hover:bg-[#26333D]"
                      >
                        Close — was warranted
                      </button>
                      <button
                        onClick={() => act(q.id, 'clear', false)}
                        className="rounded bg-[#1E2830] px-3 py-1.5 text-sm hover:bg-[#26333D]"
                      >
                        Close — not warranted
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )
        ) : (
          <>
            <div className="mb-5 flex flex-wrap gap-6">
              {Object.entries(funnel).map(([channel, counts]) => (
                <div key={channel}>
                  <p className="text-xs uppercase tracking-wide text-[#5F6D79]">
                    {channel.replace('_', ' ')}
                  </p>
                  <p className="mt-1 text-lg tabular-nums">
                    {counts.converted}
                    <span className="text-[#5F6D79]"> / {counts.leads}</span>
                  </p>
                </div>
              ))}
            </div>

            {leads.length === 0 ? (
              <p className="py-10 text-sm text-[#5F6D79]">No leads yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-[#5F6D79]">
                  <tr className="border-b border-[#1E2830]">
                    <th className="pb-2 font-medium">Channel</th>
                    <th className="pb-2 font-medium">Status</th>
                    <th className="pb-2 font-medium">Risk</th>
                    <th className="pb-2 text-right font-medium">Messages</th>
                    <th className="pb-2 text-right font-medium">Facts</th>
                    <th className="pb-2 text-right font-medium">Last activity</th>
                  </tr>
                </thead>
                <tbody>
                  {leads.map((l) => (
                    <tr key={l.sessionId} className="border-b border-[#161E25]">
                      <td className="py-2.5">{l.channel.replace('_', ' ')}</td>
                      <td className="py-2.5 text-[#A9B6C1]">
                        {l.kind === 'patient' ? 'registered' : 'guest'}
                      </td>
                      <td className="py-2.5">
                        <span
                          className={
                            l.highestRisk === 'high'
                              ? 'text-[#FF8A8A]'
                              : l.highestRisk === 'medium'
                                ? 'text-[#E0B060]'
                                : 'text-[#7C8A96]'
                          }
                        >
                          {l.highestRisk}
                        </span>
                      </td>
                      <td className="py-2.5 text-right tabular-nums">
                        {l.messageCount}
                      </td>
                      <td className="py-2.5 text-right tabular-nums">
                        {l.factCount}
                      </td>
                      <td className="py-2.5 text-right text-[#7C8A96]">
                        {l.lastMessageAt ? ago(l.lastMessageAt) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  );
}
