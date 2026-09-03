'use client';

import { useState, useRef, useEffect } from 'react';

const CLINIC_ID = '11111111-1111-1111-1111-111111111111';
const SESSION_ID = '22222222-2222-2222-2222-222222222222';

interface Msg {
  role: 'you' | 'clinic';
  text: string;
  risk?: 'low' | 'medium' | 'high';
  halt?: boolean;
  emergencyNumber?: string;
}

interface Fact {
  id: string;
  kind: string;
  value: string;
  citations: Array<{ body_raw: string; created_at: string }>;
}

export default function Intake() {
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: 'clinic',
      text: 'Hello. Tell us what is going on and we will help you find the right care. This assistant is an AI, not a doctor.',
    },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [halted, setHalted] = useState<{ number: string } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function loadFacts() {
    try {
      const r = await fetch(`/api/profile?sessionId=${SESSION_ID}`);
      const d = await r.json();
      setFacts(d.facts ?? []);
    } catch {
      /* profile is supplementary; failure here must not break intake */
    }
  }

  useEffect(() => {
    loadFacts();
  }, []);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;

    setMessages((m) => [...m, { role: 'you', text }]);
    setInput('');
    setBusy(true);

    try {
      const res = await fetch('/api/intake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clinicId: CLINIC_ID,
          sessionId: SESSION_ID,
          text,
        }),
      });
      const d = await res.json();

      if (!res.ok) throw new Error(d.error ?? 'Request failed');

      setMessages((m) => [
        ...m,
        {
          role: 'clinic',
          text: d.reply,
          risk: d.riskLevel,
          halt: d.halt,
          emergencyNumber: d.emergencyNumber,
        },
      ]);

      if (d.halt) setHalted({ number: d.emergencyNumber });
      loadFacts();
    } catch (err) {
      setMessages((m) => [
        ...m,
        {
          role: 'clinic',
          text: 'That message did not reach us. Please try again, and if this is urgent call 999.',
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0F3E44] text-[#FBFAF7]">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8 lg:flex-row">
        {/* conversation */}
        <main className="flex flex-1 flex-col">
          <header className="mb-6">
            <h1 className="text-2xl font-semibold tracking-tight">
              Klinik Nightingale
            </h1>
            <p className="mt-1 text-sm text-[#9DBFC2]">
              Tell us what is happening. We will route you to the right care.
            </p>
          </header>

          {halted && (
            <div
              role="alert"
              className="mb-5 rounded-lg border-2 border-[#C1272D] bg-[#C1272D]/15 p-5"
            >
              <p className="text-lg font-semibold text-[#FF8A8A]">
                This needs urgent medical attention
              </p>
              <p className="mt-2 text-sm leading-relaxed text-[#FBFAF7]">
                Do not wait for a reply from us. Call emergency services or go
                to your nearest emergency department now.
              </p>
              <a
                href={`tel:${halted.number}`}
                className="mt-4 inline-block rounded-md bg-[#C1272D] px-6 py-3 text-lg font-bold text-white"
              >
                Call {halted.number}
              </a>
            </div>
          )}

          <div className="flex-1 space-y-4">
            {messages.map((m, i) => (
              <div
                key={i}
                className={m.role === 'you' ? 'flex justify-end' : 'flex'}
              >
                <div
                  className={
                    m.role === 'you'
                      ? 'max-w-[80%] rounded-2xl rounded-br-sm bg-[#1C5A61] px-4 py-3'
                      : m.halt
                        ? 'max-w-[80%] rounded-2xl rounded-bl-sm border border-[#C1272D] bg-[#2A1618] px-4 py-3'
                        : 'max-w-[80%] rounded-2xl rounded-bl-sm bg-[#17494F] px-4 py-3'
                  }
                >
                  <p className="text-[15px] leading-relaxed">{m.text}</p>
                  {m.risk && m.risk !== 'low' && (
                    <p className="mt-2 text-xs text-[#9DBFC2]">
                      Flagged for clinical review
                    </p>
                  )}
                </div>
              </div>
            ))}
            {busy && (
              <p className="text-sm text-[#9DBFC2]">Reviewing your message…</p>
            )}
            <div ref={endRef} />
          </div>

          <div className="mt-6 flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
              placeholder="Describe what you are experiencing"
              disabled={busy}
              className="flex-1 rounded-lg border border-[#2A6B72] bg-[#0B3238] px-4 py-3 text-[15px] placeholder:text-[#6D9599] focus:border-[#5FB0B8] focus:outline-none"
            />
            <button
              onClick={send}
              disabled={busy || !input.trim()}
              className="rounded-lg bg-[#5FB0B8] px-5 py-3 font-medium text-[#0B3238] disabled:opacity-40"
            >
              Send
            </button>
          </div>
          <p className="mt-3 text-xs text-[#6D9599]">
            This is an AI assistant, not a doctor. It does not diagnose or give
            medical advice.
          </p>
        </main>

        {/* living memory, with visible provenance */}
        <aside className="lg:w-72">
          <h2 className="mb-3 text-sm font-medium text-[#9DBFC2]">
            What we have recorded
          </h2>
          {facts.length === 0 ? (
            <p className="text-sm text-[#6D9599]">
              Nothing yet. What you tell us appears here, with the message it
              came from.
            </p>
          ) : (
            <ul className="space-y-3">
              {facts.map((f) => (
                <li
                  key={f.id}
                  className="rounded-lg bg-[#17494F] p-3 text-sm"
                >
                  <p className="text-xs text-[#9DBFC2]">
                    {f.kind.replace('_', ' ')}
                  </p>
                  <p className="mt-0.5 font-medium">{f.value}</p>
                  {f.citations[0] && (
                    <p className="mt-2 border-l-2 border-[#2A6B72] pl-2 text-xs italic text-[#9DBFC2]">
                      from: “{f.citations[0].body_raw.slice(0, 60)}
                      {f.citations[0].body_raw.length > 60 ? '…' : ''}”
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}
