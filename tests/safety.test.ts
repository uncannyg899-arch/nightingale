/**
 * Safety tests.
 *
 * Run with: npm test
 *
 * These cover the paths where a failure is a safety failure rather
 * than a bug: missed emergencies, leaked identifiers, and risk levels
 * that can be talked back down.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { redact, assertSafeForModel } from '../lib/redaction.ts';
import {
  assessDeterministic,
  assessConversation,
  combineWithModel,
  maxLevel,
} from '../lib/risk.ts';

/* ================================================================
 * test_risk_escalation
 * A missed emergency is the worst failure this system can have.
 * ================================================================ */

test('emergency phrases always escalate to high', () => {
  const emergencies = [
    'I have crushing chest pain',
    'chest feels tight and heavy since morning',
    'pain radiating to my left arm',
    'I cannot breathe properly',
    'my face is drooping and speech is slurred',
    'bleeding heavily wont stop',
    'he passed out and is unresponsive',
    'my throat is closing up',
    'I want to kill myself',
    'pregnant and bleeding',
    'my son took too many pills, overdose',
  ];

  for (const text of emergencies) {
    const r = assessDeterministic(text);
    assert.equal(r.level, 'high', `should be high risk: "${text}"`);
    assert.equal(r.halt, true, `should halt advice: "${text}"`);
  }
});

test('emergency detection works in Bahasa Malaysia', () => {
  const emergencies = [
    'sakit dada sangat teruk',
    'sesak nafas sejak pagi',
    'tak boleh nafas',
    'muntah darah',
    'dia pengsan',
    'bunuh diri',
  ];

  for (const text of emergencies) {
    const r = assessDeterministic(text);
    assert.equal(r.level, 'high', `should be high risk: "${text}"`);
  }
});

test('routine enquiries are not escalated', () => {
  // Over-triage has a real cost: it floods the clinician queue and
  // trains staff to ignore alerts.
  const routine = [
    'I want to book a dental cleaning',
    'what are your opening hours',
    'mild headache since yesterday',
    'I need a repeat prescription',
    'saya nak buat check up',
    'my chest of drawers is broken',
  ];

  for (const text of routine) {
    const r = assessDeterministic(text);
    assert.equal(r.level, 'low', `should be low risk: "${text}"`);
    assert.equal(r.halt, false);
  }
});

test('urgent-but-not-emergency cases are medium', () => {
  const urgent = [
    'fever for 4 days not going down',
    'demam tinggi 3 hari',
    'severe pain in my stomach',
    'cant keep any fluids down',
    'baby has fever and not feeding',
  ];

  for (const text of urgent) {
    assert.equal(assessDeterministic(text).level, 'medium', text);
  }
});

/* ================================================================
 * Escalation is one-way
 * ================================================================ */

test('risk cannot be talked back down within a conversation', () => {
  const conversation = [
    'I have crushing chest pain',
    'actually never mind, I think it was just gas',
    'I feel completely fine now',
  ];

  const result = assessConversation(conversation);
  assert.equal(
    result.level,
    'high',
    'a patient retracting a symptom must not clear the flag'
  );
});

test('the model can raise risk but never lower it', () => {
  const high = assessDeterministic('I have crushing chest pain');

  // Model disagrees and says low. It must be ignored.
  const combined = combineWithModel(high, 'low');
  assert.equal(combined.level, 'high');

  // Model escalates beyond the rules. It must be respected.
  const low = assessDeterministic('I need to book an appointment');
  assert.equal(combineWithModel(low, 'medium').level, 'medium');
});

test('the model alone cannot declare high risk', () => {
  // A false-positive high halts the assistant and sends someone to
  // emergency services. The model may flag for review (medium) but
  // cannot trigger that on its own with no rule support.
  const routine = assessDeterministic('I need to book an appointment');
  const result = combineWithModel(routine, 'high');

  assert.equal(result.level, 'medium', 'model-only high must cap to medium');
  assert.equal(result.halt, false, 'must not halt the assistant');
});

test('the model can confirm high risk when rules already fired', () => {
  // When the deterministic layer found something, the model agreeing
  // is corroboration, not speculation.
  const cardiac = assessDeterministic('I have crushing chest pain');
  assert.equal(combineWithModel(cardiac, 'high').level, 'high');
  assert.equal(combineWithModel(cardiac, 'high').halt, true);
});

test('maxLevel orders risk correctly', () => {
  assert.equal(maxLevel('low', 'high'), 'high');
  assert.equal(maxLevel('medium', 'low'), 'medium');
  assert.equal(maxLevel('high', 'medium'), 'high');
});

/* ================================================================
 * test_redaction
 * ================================================================ */

test('Malaysian identifiers are redacted', () => {
  const cases: Array<[string, string]> = [
    ['my IC is 900101-14-5523', 'malaysian_ic'],
    ['call me on 012-345 6789', 'phone'],
    ['email ali@example.com', 'email'],
    ['my name is Ahmad Zulkifli', 'name'],
    ['Nama saya Siti binti Hassan', 'name'],
    ['I live at Jalan Ampang 22', 'address'],
  ];

  for (const [text, expectedType] of cases) {
    const { redactions } = redact(text);
    assert.ok(
      redactions.some((r) => r.type === expectedType),
      `expected ${expectedType} in "${text}"`
    );
  }
});

test('clinical text is not over-redacted', () => {
  // Stripping clinical signal would break triage.
  const clinical = [
    'I am having severe chest pain right now',
    'just a headache since Tuesday',
    'I have been coughing for a week',
  ];

  for (const text of clinical) {
    const { redactions } = redact(text);
    assert.equal(redactions.length, 0, `should not redact: "${text}"`);
  }
});

test('redaction output contains no original identifiers', () => {
  const { redacted } = redact(
    'my name is Ahmad Zulkifli, IC 900101-14-5523, phone 012-345 6789'
  );
  assert.ok(!redacted.includes('Ahmad'));
  assert.ok(!redacted.includes('900101'));
  assert.ok(!redacted.includes('6789'));
});

test('the model gate fails closed on unredacted PHI', () => {
  // assertSafeForModel must throw rather than warn-and-continue.
  assert.throws(
    () => assertSafeForModel('my IC is 900101-14-5523'),
    /unredacted identifier/
  );

  // And must not block clean text.
  assert.doesNotThrow(() => assertSafeForModel('I have a headache'));
});

test('redaction records no original values', () => {
  // `original` is used in development only and must never survive
  // into anything persisted.
  const { redactions } = redact('my IC is 900101-14-5523');
  for (const r of redactions) {
    assert.equal(
      (r as Record<string, unknown>).original,
      undefined,
      'original text must be stripped before storage'
    );
  }
});
