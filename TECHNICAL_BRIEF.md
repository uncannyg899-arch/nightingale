# Nightingale Patient Intake - Technical Brief

Submission: 48-Hour AI Challenge, Nightingale AI x Sunway
Date: 3 September 2026

## 1. What was built

A first-touch patient intake system with a hard safety boundary. A person describes a symptom in plain language; the system assesses urgency, halts entirely on anything resembling an emergency, and builds a structured clinical profile where every recorded fact points back to the message it came from.

Working end to end: risk gating, PHI redaction, escalation, Living Memory with visible provenance, and a patient-facing interface.

Stack: Next.js 16 (TypeScript), Supabase (Postgres, RLS), Gemini 3.6 Flash / Flash-Lite

## 2. The central design decision

Risk detection does not rely on the language model.

Deterministic pattern rules run first, on raw text, before anything else happens. A model runs afterwards as a second opinion, and the final level is the MAXIMUM of the two, never the intersection. The model can raise urgency; it can never lower it.

The reasoning: a model that occasionally misses "crushing chest pain" is not an acceptable safety boundary. A regex that catches it every time is not sophisticated, but it is reliable.

This was validated unintentionally during the build. Google deprecated the model we started on, mid-build, for new accounts. Every LLM call failed for roughly an hour. Risk gating, escalation, and the emergency response continued working correctly throughout, because none of them depend on the model being reachable.

Rules cover nine emergency categories in English and Bahasa Malaysia: cardiac, respiratory, stroke, haemorrhage, altered consciousness, anaphylaxis, suicidal ideation, obstetric emergency, and trauma.

## 3. Triage framework

Levels map to the Manchester Triage System (Manchester Triage Group, UK, 1994), a recognised international framework, rather than a rubric invented for this project. MTS Red/Orange maps to high, Yellow to medium, Green/Blue to low.

The system routes; it does not diagnose. No output names a condition or recommends treatment, which would cross into practice of medicine, reserved to registered practitioners under Malaysia's Medical Act 1971.

## 4. Safety properties enforced structurally

These are database constraints and hard gates, not conventions the application is trusted to follow.

Escalation is one-way. A Postgres trigger (trg_one_way_risk) rejects any risk downgrade while an uncleared escalation exists. A patient saying "actually I'm fine now" after reporting chest pain does not clear the flag. A second trigger restricts clearance to clinicians specifically.

Redaction fails closed. assertSafeForModel() runs before every outbound model call and throws if identifiers remain. It does not log a warning and proceed. This caught a real bug during the build: our own prompt template "Patient message: ..." matched the name-detection pattern, and the gate blocked the call rather than sending anything questionable.

Audit logs cannot carry PHI. A trigger rejects any audit row whose metadata contains content-bearing keys.

Safety precedes convenience in the pipeline. Escalations are written before any model call. If the LLM is slow, rate-limited, or down, a high-risk patient is still escalated.

## 5. Living Memory

Facts are extracted from redacted text and stored with mandatory provenance, a citation row linking the fact to its source message. If the citation write fails, the fact is deleted. An unsourced clinical claim is worse than no claim.

Corrections supersede rather than overwrite. When someone retracts a stated allergy, the original is marked retracted and the correction points back to it. Overwriting would have quietly undermined the provenance guarantee through the mutation logic itself.

Provenance is shown to the patient in the interface, not just stored.

## 6. Redaction scope, honestly

Pattern-based, covering Malaysian IC, passport, phone, email, payment cards, dates of birth, street addresses, and names in explicit self-identification forms.

It is a floor, not a guarantee. Structured identifiers are caught reliably. Free-text names partially. Combination re-identification, a rare condition plus a small town, is not addressed at all.

Name detection is deliberately conservative rather than aggressive: over-redaction destroys the clinical signal the triage rules depend on.

## 7. Cost architecture

Tiered routing: classification and fact extraction use Flash-Lite; only the conversational reply uses the larger model.

Capped context: the model receives a structured profile summary, not the full transcript. Cost stays roughly flat as conversations lengthen.

Independent model calls run in parallel, which cut response time from about 22s to a fraction of that.

## 8. Assumption challenged

The brief treats risk gating as purely a safety feature. Structurally it is also the conversion engine.

The escalation path (symptom, high risk, clinical escalation, clinic contact, appointment) means every escalation is simultaneously a safety action and a qualified lead. A system that over-triages produces more clinic contacts while appearing more clinically responsible.

No intent is required for this gradient to exist; it follows from the architecture. The brief correctly instructs biasing toward over-triggering on ambiguity, but specifies no counterweight: nothing measures the cost of a false-positive escalation.

Proposed mitigation: track clinician-confirmed-appropriate-escalation rate. This distinguishes "escalates often" from "escalates well". The field (escalations.clinically_appropriate) is already in the schema; it costs one boolean and one clinician action.

Counter-argument, stated plainly: if Nightingale prices flat per-clinic rather than per-lead, the volume incentive is weak and this is latent rather than active. Pricing is unknown to us. Offered as a structural risk to design against, not a claim about current practice.

## 9. A second observation on channel ethics

The brief scopes its green/yellow/red ethics framework to acquisition channels. Malaysia's Medicine Advertisements Board guidelines (MAB 1/2023) and the MMC dissemination guideline prohibit exaggerated or solicitous healthcare promotion, and those rules apply to the product's own conversion content too: guest value events, earned-email hooks, urgency framing in replies.

The ethics grid should extend to conversion copy, not only to where leads come from.

## 10. What is not built

Stated directly rather than omitted.

- Authentication and guest-to-patient trust transition. Schema supports it; no auth flow implemented.
- Clinician warm-lead view and escalation queue. Data model complete, interface not built.
- Channel attribution contracts. Modelled in the schema; no ingestion endpoints.
- Malay-language replies. Emergency detection works in Bahasa Malaysia; generated responses are English-only. Detecting an emergency in a language the system cannot then respond in is a partial solution.
- Deployment. Runs locally; not hosted.

## 11. Known limitations beyond scope

- Proxy and caregiver intake, a parent messaging about a child, is not represented in the identity model.
- Shared devices, common in Malaysian households; no session timeout policy.
- Accessibility: assumes a smartphone, data connection, literacy, and text interaction. A genuine equity gap.
- After-hours escalation is implemented but untested against a real clinician workflow.
- Regulatory uncertainty: the Medical Act 1971 predates conversational AI, and no MMC or MOH guidance addressing AI intake assistants was found. Whether a non-diagnostic triage assistant constitutes practice of medicine is genuinely unsettled in Malaysia. We designed conservatively rather than to a rule that does not yet exist. This is not a substitute for legal review.

## 12. Summary

The system does one thing thoroughly rather than many things partially: it will not miss an emergency, it will not send PHI to a third party, it will not let a risk flag be cleared by anyone but a clinician, and it will not record a clinical fact it cannot trace to a source.

The acquisition funnel, clinician interface, and test suite are designed but unbuilt. Given the choice between a broad system with a soft safety boundary and a narrow one with a hard boundary, we built the second.
