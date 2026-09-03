# Nightingale Patient Intake

A first-touch patient intake system with a hard safety boundary. Someone describes a symptom in plain language; the system assesses urgency, halts entirely on anything resembling an emergency, and builds a structured clinical profile where every fact traces back to the message it came from.

Built for the Nightingale AI × Sunway 48-Hour Challenge. See `TECHNICAL_BRIEF.md` for design reasoning and an honest account of what is and is not implemented.

---

## Setup

**Requires:** Node.js 20+, a Supabase project, a Gemini API key.

```bash
npm install
```

**1. Database**

In the Supabase SQL Editor, run in order:

```
supabase/migrations/001_initial_schema.sql
supabase/seed.sql
```

The schema creates 11 tables, 14 row-level security policies, and 3 triggers that enforce safety properties in the database rather than in application code. The seed creates one demo clinic and one guest session.

**2. Environment**

Copy `.env.local.example` to `.env.local` and fill in:

```
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...

LLM_PROVIDER=gemini
GEMINI_API_KEY=...
LLM_MODEL_FAST=gemini-flash-lite-latest
LLM_MODEL_CHAT=gemini-3.6-flash
```

The service role key bypasses row-level security and is server-only. `lib/supabase.ts` throws if it is ever reached from the browser.

**3. Run**

```bash
npm run dev
```

Open http://localhost:3000

---

## Trying it

Type into the chat:

| Message | Expected |
|---|---|
| `I would like to book a dental cleaning` | Low risk, normal reply |
| `I have had a headache for three days and I'm allergic to penicillin` | Facts appear in the right panel with their source message |
| `I have crushing chest pain` | Everything halts. Red alert, tappable Call 999, escalation written to the database |
| `sesak nafas sejak pagi` | Same halt — emergency detection works in Bahasa Malaysia |

---

## Tests

```bash
npm test
```

Covers the safety-critical paths: emergency phrase detection (English and Malay), false-positive resistance, escalation stickiness across a conversation, redaction of Malaysian identifiers, and the model-cannot-downgrade-risk rule.

---

## Where things live

**Redaction — `lib/redaction.ts`**

Pattern-based, deterministic. Runs before any text reaches a model. `assertSafeForModel()` is called inside `lib/llm.ts` before every outbound request and **throws** if identifiers remain — it does not log a warning and proceed. Covers Malaysian IC, passport, phone, email, payment cards, dates of birth, addresses, and names in self-identification forms.

Coverage is a floor, not a guarantee. Structured identifiers are caught reliably; free-text names partially; combination re-identification not at all. See brief §6.

**Risk gating — `lib/risk.ts`**

Deterministic rules run first, on raw text. The model runs second and its opinion is combined with `maxLevel()` — it can raise urgency, never lower it. Nine emergency categories in English and Bahasa Malaysia, mapped to Manchester Triage System tiers.

`assessConversation()` is sticky: a later reassuring message cannot lower an earlier high assessment.

**Access control — `supabase/migrations/001_initial_schema.sql`**

Enforced by Postgres row-level security, not application logic:

- Patients read only their own sessions, messages, and facts (`auth_user_id = auth.uid()`)
- Staff and clinicians read their own clinic's data (`is_clinic_staff(clinic_id)`)
- Escalations are staff-facing only; patients never read them
- Only clinicians may update escalations
- `audit_logs` has a select policy and no update or delete policy, making it append-only

Three triggers enforce what conventions cannot:

- `trg_one_way_risk` — rejects a risk downgrade while an uncleared escalation exists
- `trg_clinician_clear` — only a clinician may clear an escalation, not staff
- `trg_audit_phi_free` — rejects audit rows whose metadata carries content-bearing keys

**Intake pipeline — `lib/intake.ts`**

Order of operations is the safety design:

1. Risk assess on raw text (clinical signal intact)
2. Redact
3. Persist both versions
4. Escalate if high — **before** any model call
5. Only then generate a reply, from redacted text

Step 4 before step 5 means a high-risk patient is escalated even if the model is down, slow, or rate-limited.

**Living Memory — `lib/memory.ts`**

Facts stored with mandatory provenance. If the citation write fails, the fact is deleted — an unsourced clinical claim is worse than none. Corrections supersede rather than overwrite, preserving the trail.

---

## API

```
POST /api/intake     { clinicId, sessionId, text }
GET  /api/profile    ?sessionId=...
```

---

## Not implemented

Authentication and guest→patient transition, clinician escalation queue, channel attribution endpoints, Malay-language replies (detection works, generation does not), deployment. Schema and design support all of these. See brief §10.
