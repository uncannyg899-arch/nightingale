/**
 * Guest value content
 * ---------------------------------------------------------------
 * Deliberately free of server dependencies so it can be tested in
 * isolation. This content is patient-facing and non-diagnostic; the
 * test suite asserts that it stays that way, because guest value is
 * the most tempting place to drift into clinical claims — it is the
 * content designed to be appealing.
 */

export type ValueEventKind = 'visit_prep_checklist' | 'clinic_info';

/**
 * Practical preparation steps. Nothing here assesses the person's
 * condition, names a diagnosis, or comments on treatment.
 */
export function buildVisitPrepChecklist(): string[] {
  return [
    'Bring your IC or passport',
    'Bring any medicines you are currently taking, in their boxes',
    'Note when your symptoms started and what makes them better or worse',
    'Bring your insurance or panel card if you have one',
    'If someone is coming with you, they can help you remember what is said',
  ];
}
