/**
 * Trust transition tests.
 *
 * These cover the CONVERSION LOGIC without a live database. The
 * database-dependent paths (actual row updates) are exercised by the
 * running application; what is tested here is the decision logic that
 * governs whether a conversion is allowed at all — which is where the
 * safety-relevant mistakes would be.
 *
 * Run with: npm test
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildVisitPrepChecklist } from '../lib/guest-value.ts';

/* ================================================================
 * Guest value must be non-diagnostic
 * ================================================================ */

test('guest value contains no medical advice', () => {
  const items = buildVisitPrepChecklist();

  assert.ok(items.length > 0, 'checklist must not be empty');

  // The whole system's regulatory position depends on never telling
  // someone what condition they have or what to take for it. Guest
  // value is the most tempting place to slip, because it is the
  // content designed to be appealing.
  //
  // Phrases are specific rather than broad on purpose: an earlier
  // version flagged "if you have one" (about an insurance card) as a
  // medical claim, which would have pushed us to reword harmless
  // copy. A test that cries wolf gets ignored.
  const forbidden = [
    'diagnos',
    'you have a',
    'you may have',
    'you might have',
    'sounds like',
    'prescri',
    'you should take',
    'treatment for',
    'probably nothing',
    'nothing serious',
    'not serious',
    "don't worry",
    'no need to worry',
  ];

  for (const item of items) {
    const lower = item.toLowerCase();
    for (const term of forbidden) {
      assert.ok(
        !lower.includes(term),
        `guest value must not contain "${term}": "${item}"`
      );
    }
  }
});

test('guest value is practical, not clinical', () => {
  const items = buildVisitPrepChecklist();
  const joined = items.join(' ').toLowerCase();

  // It should be about preparing for a visit — documents, medicines
  // to bring, what to note down — not about the person's condition.
  assert.ok(
    joined.includes('bring') || joined.includes('note'),
    'checklist should give practical preparation steps'
  );
});
