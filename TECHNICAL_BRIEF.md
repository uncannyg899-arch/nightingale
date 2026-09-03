# Nightingale Patient Intake — Technical Brief

**Submission:** 48-Hour AI Challenge, Nightingale AI × Sunway
**Repository:** github.com/uncannyg899-arch/nightingale
**Live:** nightingale-teal.vercel.app
**Date:** 3 September 2026

---

## 1. What was built

A first-touch-to-care patient intake system with a hard safety boundary. A person describes a symptom in plain language; the system assesses urgency, halts entirely on anything resembling an emergency, builds a structured clinical profile where every fact traces back to its source message, and — only after giving something useful — invites them to identify themselves.

Working end to end and deployed: risk gating, PHI redaction, escalation with acknowledgement SLA, Living Memory with visible provenance, guest value, guest-to-patient trust transition, and a clinician queue.

**Stack:** Next.js 16 (TypeScript) · Supabase (Postgres, RLS, Auth) · Gemini 3.6 Flash / Flash-Lite

---

## 2. The central design decision

**Risk detection does not rely on the language model.**

Deterministic pattern rules run first, on raw text, before anything else happens. A model runs afterwards as a second opinion, and the final level is the **maximum** of the two, never the intersection.

The reasoning: a model that occasionally misses "crushing chest pain" is not an acceptable safety boundary. A regex that catches it every time is not sophisticated, but it is reliable. Sophistication is the wrong thing to optimise on this particular path.

This was validated unintentionally. Google deprecated the model we started on, mid-build, for new accounts. Every LLM call failed for roughly an hour. **Risk gating, escalation, and the emergency response continued working correctly throughout**, because none of them depend on the model being reachable.

Rules cover nine emergency categories in English and Bahasa Malaysia: cardiac, respiratory, stroke, haemorrhage, altered consciousness, anaphylaxis, suicidal ideation, obstetric emergency, and trauma.

### The escalation cap

The model can raise risk, but **cannot declare high risk alone** — only medium — unless the deterministic rules also fired.

This asymmetry is deliberate. A false negative is dangerous; a false positive is also costly, just less visibly. A HIGH assessment halts the assistant and tells someone to call emergency services. A model that over-triages routine symptoms would flood the clinician queue and, over time, train staff to ignore the alerts that matter. The cap means the model can flag for review freely but cannot trigger an emergency response on its own speculation.

This was added after observing the deployed system flag a plain headache for clinical review — precisely the failure mode described in §8.

---

## 3. Triage framework

Levels map to the **Manchester Triage System** (Manchester Triage Group, UK, 1994), a recognised international framework, rather than a rubric invented for this project. MTS Red/Orange maps to high, Yellow to medium, Green/Blue to low.

The system routes; it does not diagnose. No output names a condition or recommends treatment, which would cross into practice of medicine, reserved to registered practitioners under Malaysia's Medical Act 1971.

---

## 4. Safety properties enforced structurally

Database constraints and hard gates, not conventions the application is trusted to follow.

**Escalation is one-way.** A Postgres trigger (`trg_one_way_risk`) rejects any risk downgrade while an uncleared escalation exists. A patient saying "actually I'm fine now" after reporting chest pain does not clear the flag. A second trigger (`trg_clinician_clear`) restricts clearance to clinicians specifically — staff cannot do it, even if the application code were wrong.

**Redaction fails closed.** `assertSafeForModel()` runs before every outbound model call and throws if identifiers remain. It does not log a warning and proceed. This caught a real bug during the build: our own prompt template `"Patient message: ..."` matched the name-detection pattern, and the gate blocked the call rather than sending anything questionable.

**Audit logs cannot carry PHI.** A trigger rejects any audit row whose metadata contains content-bearing keys.

**Safety precedes convenience in the pipeline.** Escalations are written before any model call. If the LLM is slow, rate-limited, or down, a high-risk patient is still escalated and still sees the emergency response.

**Access control is row-level.** Patients read only their own sessions and facts; staff read their clinic's data; escalations are staff-facing only; `audit_logs` has a select policy and no update or delete policy, making it append-only.

---

## 5. Living Memory

Facts are extracted from redacted text and stored with mandatory provenance — a citation row linking the fact to its source message. **If the citation write fails, the fact is deleted.** An unsourced clinical claim is worse than no claim.

Corrections **supersede rather than overwrite**. When someone retracts a stated allergy, the original is marked retracted and the correction points back to it. Overwriting would have quietly undermined the provenance guarantee through the mutation logic itself.

Provenance is shown to the patient in the interface, not merely stored. Each recorded fact displays the message it came from.

---

## 6. Trust transition

Guest value is delivered **before** identity is requested: a visit preparation checklist offered after the first exchange, deliberately practical rather than clinical. The test suite asserts it contains no diagnostic language, because guest value is the most tempting place to drift — it is the content designed to be appealing.

The email prompt appears only after two exchanges, and is **suppressed entirely when risk is high**. Asking a chest-pain patient for their email address would be indefensible.

Sign-in is magic-link: nothing to store, forget, or reuse. In a health context that is one fewer credential that can leak.

**Conversion updates the existing session row rather than creating a new one.** Nothing is copied, so nothing can be copied incorrectly — every message, fact, citation, risk assessment and escalation stays attached automatically. The interface reports the preserved counts back to the person, making the guarantee visible at the moment they decide whether to trust the system with their identity.

A session already linked to another account is refused rather than reassigned. This is the shared-device risk — common in Malaysian households — handled rather than merely noted.

---

## 7. Redaction scope, honestly

Pattern-based, covering Malaysian IC, passport, phone, email, payment cards, dates of birth, street addresses, and names in explicit self-identification forms including Malay constructions and honorifics.

**It is a floor, not a guarantee.** Structured identifiers are caught reliably. Free-text names partially. Combination re-identification — a rare condition plus a small town — is not addressed at all.

Name detection is deliberately conservative rather than aggressive: over-redaction destroys the clinical signal the triage rules depend on.

---

## 8. Assumption challenged

**The brief treats risk gating as purely a safety feature. Structurally it is also the conversion engine.**

The escalation path — symptom → high risk → clinical escalation → clinic contact → appointment — means every escalation is simultaneously a safety action and a qualified lead. A system that over-triages produces more clinic contacts while appearing more clinically responsible.

No intent is required for this gradient to exist; it follows from the architecture. The brief correctly instructs biasing toward over-triggering on ambiguity, but specifies no counterweight: nothing in the system measures the cost of a false-positive escalation.

**Two mitigations, both implemented.**

*Clinician-confirmed-appropriate-escalation rate.* Closing an escalation forces the clinician to record whether it was warranted. The rate is the headline figure on the clinician dashboard, not a buried statistic. Without it, a false-positive high looks identical to a true one in every report the clinic ever runs.

*The escalation cap* described in §2, which prevents the model from generating high-risk escalations on its own.

**Counter-argument, stated plainly:** if Nightingale prices flat per-clinic rather than per-lead, the volume incentive is weak and this is latent rather than active. Pricing is unknown to us. Offered as a structural risk to design against, not a claim about current practice.

---

## 9. A second observation on channel ethics

The brief scopes its green/yellow/red ethics framework to *acquisition channels*. Malaysia's Medicine Advertisements Board guidelines (MAB 1/2023) and the MMC dissemination guideline prohibit exaggerated or solicitous healthcare promotion — and those rules apply to the product's own conversion content too: guest value events, earned-email hooks, urgency framing in replies.

The ethics grid should extend to conversion copy, not only to where leads come from. Our own guest value content is tested against this standard.

---

## 10. Cost architecture

**Tiered routing.** Classification and fact extraction use Flash-Lite; only the conversational reply uses the larger model. Most calls take the cheap path.

**Capped context.** The model receives a structured profile summary, not the full transcript, so cost stays roughly flat as conversations lengthen rather than growing linearly.

**Parallel calls.** Risk classification and fact extraction are independent and run concurrently, which cut response time from roughly 22 seconds to a fraction of that.

**Hard timeouts.** Model calls abort after 15 seconds. A hanging third-party call cannot stall an intake request, because the deterministic layers can carry the response alone.

---

## 11. What is not built

- **Channel attribution endpoints.** `staff_referral` and `social_comment` are modelled in the schema with attribution preserved end to end, but there are no ingestion endpoints and no Meta or TikTok integration.
- **Clinician authentication.** The clinician view reads live data and its actions are wired, but they are disabled pending a clinic-staff auth flow. Patient auth is implemented; staff auth is not. The interface says so rather than pretending otherwise.
- **Malay-language replies.** Emergency *detection* works in Bahasa Malaysia; generated responses are English-only. Detecting an emergency in a language the system cannot then respond in is a partial solution and should be treated as a gap, not a feature.
- **Demo video.**

---

## 12. Known limitations beyond scope

- **Proxy and caregiver intake** — a parent messaging about a child, or a caregiver about an elderly parent, is common in real clinic intake and is not represented in the identity model.
- **Session timeout** — shared devices are common in Malaysian households; conversion refuses to reassign a claimed session, but there is no idle timeout.
- **Accessibility** — assumes a smartphone, data connection, literacy, and text interaction. A genuine equity gap for elderly and lower-income patients.
- **Magic link deliverability** — Supabase's default email service is rate-limited and frequently classified as spam. Adequate for demonstration, not for production.
- **After-hours escalation** — implemented (high risk outside office hours surfaces a direct emergency action rather than a silent queue) but untested against a real clinician workflow.
- **Regulatory uncertainty** — the Medical Act 1971 predates conversational AI, and no MMC or MOH guidance addressing AI intake assistants was found. Whether a non-diagnostic triage assistant constitutes practice of medicine is genuinely unsettled in Malaysia. We designed conservatively rather than to a rule that does not yet exist. This is not a substitute for legal review.

---

## 13. Tests

Sixteen tests, run with `npm test`:

- Emergency phrase detection across nine categories, English and Bahasa Malaysia
- False-positive resistance ("my chest of drawers is broken" stays low)
- Escalation stickiness across a conversation, including patient retraction
- The model cannot lower risk, and cannot raise it to high unaided
- Redaction of Malaysian identifiers; clinical text left intact
- The model gate throws rather than warning on unredacted PHI
- Guest value content contains no diagnostic language

---

## 14. Summary

The system does one thing thoroughly rather than many things partially: it will not miss an emergency, it will not send PHI to a third party, it will not let a risk flag be cleared by anyone but a clinician, and it will not record a clinical fact it cannot trace to a source.

Given the choice between a broad system with a soft safety boundary and a narrow one with a hard boundary, we built the second — then extended outward from it once the boundary held.
