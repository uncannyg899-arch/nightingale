/**
 * Risk Gating — Deterministic Layer
 * ---------------------------------------------------------------
 * DESIGN PRINCIPLE: this layer runs FIRST and can only ESCALATE.
 * An LLM runs afterwards as a second opinion, and the final level is
 * the UNION (max) of both — never the intersection. A model that
 * occasionally misses "crushing chest pain" is not an acceptable
 * safety boundary; a regex that catches it every time is not
 * sophisticated, but it is reliable.
 *
 * TRIAGE FRAMEWORK: levels map to the Manchester Triage System (MTS),
 * a recognised international framework, rather than a rubric we
 * invented. MTS was developed by the Manchester Triage Group (UK,
 * 1994) and uses five categories. We collapse those five into the
 * three levels the brief requires.
 *
 * IMPORTANT: this is a ROUTING decision, not a diagnosis. Nothing here
 * names a condition or recommends treatment — that would cross into
 * practice of medicine (Medical Act 1971, Malaysia).
 *
 * KNOWN LIMITATION: phrase lists are English + Bahasa Malaysia + common
 * Manglish. Coverage of other languages and of atypical phrasing is
 * incomplete. Documented, not hidden.
 */

export type RiskLevel = 'low' | 'medium' | 'high';

export type MtsTier =
  | 'immediate'    // MTS Red
  | 'very_urgent'  // MTS Orange
  | 'urgent'       // MTS Yellow
  | 'standard'     // MTS Green
  | 'non_urgent';  // MTS Blue

export interface RiskRule {
  id: string;
  level: RiskLevel;
  mts: MtsTier;
  /** why this rule exists — surfaced in the clinician view */
  reason: string;
  patterns: RegExp[];
}

const LEVEL_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

export function maxLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  return LEVEL_ORDER[a] >= LEVEL_ORDER[b] ? a : b;
}

/* ================================================================
 * HIGH RISK — MTS Red/Orange. Halt advice, escalate immediately.
 * ================================================================ */

const HIGH_RISK_RULES: RiskRule[] = [
  {
    id: 'cardiac_chest_pain',
    level: 'high',
    mts: 'immediate',
    reason: 'Possible cardiac event — requires immediate assessment',
    patterns: [
      /\b(crushing|squeezing|tight(ness)?|pressure|heavy|heaviness)\b[^.!?]{0,40}\b(chest|dada)\b/i,
      /\bchest\b[^.!?]{0,40}\b(crushing|squeezing|tight|pressure|heavy)\b/i,
      /\bchest pain\b/i,
      /\bsakit dada\b/i,
      /\bnyeri dada\b/i,
      /\bheart attack\b/i,
      /\bserangan jantung\b/i,
      // radiating pain — classic cardiac presentation
      /\b(pain|sakit)\b[^.!?]{0,30}\b(radiat|spread|jalar)[^.!?]{0,20}\b(arm|jaw|shoulder|back|lengan|rahang)\b/i,
    ],
  },
  {
    id: 'respiratory_distress',
    level: 'high',
    mts: 'immediate',
    reason: 'Airway or breathing compromise',
    patterns: [
      /\b(can'?t|cannot|unable to|difficulty|trouble|struggling to)\s+breath/i,
      /\b(short(ness)? of breath|breathless)\b/i,
      /\bsesak nafas\b/i,
      /\bsusah bernafas\b/i,
      /\btak boleh nafas\b/i,
      /\bchoking\b/i,
      /\btercekik\b/i,
      /\bgasping\b/i,
      /\blips? (are |is )?(turning )?blue\b/i,
    ],
  },
  {
    id: 'stroke_signs',
    level: 'high',
    mts: 'immediate',
    reason: 'Possible stroke — time-critical',
    patterns: [
      /\b(face|facial|muka)\b[^.!?]{0,15}\b(droop|numb|sagging|senget)/i,
      /\bslurred speech\b/i,
      /\b(sudden|tiba-tiba)[^.!?]{0,30}\b(numb|weak|paralysis|lumpuh|lemah)\b/i,
      /\b(one side|sebelah)[^.!?]{0,20}\b(weak|numb|lemah|kebas)\b/i,
      /\bcan'?t (move|lift) (my |his |her )?(arm|leg|face)\b/i,
      /\bstroke\b/i,
      /\bangin ahmar\b/i,
    ],
  },
  {
    id: 'severe_bleeding',
    level: 'high',
    mts: 'immediate',
    reason: 'Uncontrolled haemorrhage',
    patterns: [
      /\b(heavy|severe|won'?t stop|uncontrolled|profuse)\b[^.!?]{0,20}\bbleed/i,
      /\bbleeding\b[^.!?]{0,20}\b(won'?t stop|heavily|badly)\b/i,
      /\bdarah\b[^.!?]{0,20}\b(banyak|tak berhenti)\b/i,
      /\b(vomit|cough)(ing)?\s+(up\s+)?blood\b/i,
      /\bmuntah darah\b/i,
      /\bbatuk darah\b/i,
    ],
  },
  {
    id: 'altered_consciousness',
    level: 'high',
    mts: 'immediate',
    reason: 'Reduced level of consciousness',
    patterns: [
      /\b(unconscious|passed out|fainted|collapsed|unresponsive)\b/i,
      /\bpengsan\b/i,
      /\btak sedar(kan diri)?\b/i,
      /\b(seizure|convulsion|fitting)\b/i,
      /\bsawan\b/i,
      /\bconfus(ed|ion)\b[^.!?]{0,20}\bsudden/i,
    ],
  },
  {
    id: 'anaphylaxis',
    level: 'high',
    mts: 'immediate',
    reason: 'Possible anaphylaxis',
    patterns: [
      /\banaphyla/i,
      /\b(throat|tekak)\b[^.!?]{0,20}\b(clos(e|ing)|swell|tight|bengkak)\b/i,
      /\b(tongue|lidah|face|muka)\b[^.!?]{0,15}\bswell/i,
      /\bsevere allergic reaction\b/i,
    ],
  },
  {
    id: 'suicidal_ideation',
    level: 'high',
    mts: 'immediate',
    reason: 'Risk to life — mental health crisis',
    patterns: [
      /\b(kill|hurt|harm)\s+(myself|my self)\b/i,
      /\bsuicid/i,
      /\bend (my|it all)\b[^.!?]{0,10}\blife\b/i,
      /\bwant to die\b/i,
      /\bbunuh diri\b/i,
      /\btak nak hidup\b/i,
      /\bno reason to live\b/i,
    ],
  },
  {
    id: 'obstetric_emergency',
    level: 'high',
    mts: 'immediate',
    reason: 'Obstetric emergency',
    patterns: [
      /\bpregnan(t|cy)\b[^.!?]{0,40}\b(bleed|pain|cramp)/i,
      /\bmengandung\b[^.!?]{0,40}\b(darah|sakit)/i,
      /\bwater (has )?broke(n)?\b/i,
      /\bcontraction/i,
      /\bbaby.{0,15}not moving\b/i,
    ],
  },
  {
    id: 'trauma',
    level: 'high',
    mts: 'immediate',
    reason: 'Significant trauma',
    patterns: [
      /\b(accident|kemalangan|crash)\b[^.!?]{0,30}\b(injur|hurt|bleed|cedera)/i,
      /\bhead injury\b/i,
      /\bbroken bone\b/i,
      /\bdeep (cut|wound)\b/i,
      /\boverdos/i,
      /\bpoison(ed|ing)?\b/i,
      /\bkeracunan\b/i,
    ],
  },
];

/* ================================================================
 * MEDIUM RISK — MTS Yellow. Advice permitted, but prompt review.
 * ================================================================ */

const MEDIUM_RISK_RULES: RiskRule[] = [
  {
    id: 'persistent_fever',
    level: 'medium',
    mts: 'urgent',
    reason: 'Persistent or high fever',
    patterns: [
      /\bfever\b[^.!?]{0,30}\b(\d+\s*days?|week|not going down|high)\b/i,
      /\bdemam\b[^.!?]{0,30}\b(\d+\s*hari|tinggi|tak turun)\b/i,
      /\b(39|40|41)(\.\d)?\s*(°|deg|celsius|c)\b/i,
    ],
  },
  {
    id: 'severe_pain',
    level: 'medium',
    mts: 'urgent',
    reason: 'Severe pain requiring assessment',
    patterns: [
      /\b(severe|excruciating|unbearable|worst)\b[^.!?]{0,20}\bpain\b/i,
      /\bsakit\b[^.!?]{0,15}\b(teruk|sangat|tak tahan)\b/i,
      /\bpain\b[^.!?]{0,20}\b(\d|ten)\s*(\/|out of)\s*10\b/i,
    ],
  },
  {
    id: 'dehydration',
    level: 'medium',
    mts: 'urgent',
    reason: 'Possible dehydration',
    patterns: [
      /\b(can'?t|cannot|unable to)\s+keep\b[^.!?]{0,25}\b(fluid|water|food|anything|down)\b/i,
      /\bvomit(ing)?\b[^.!?]{0,25}\b(\d+\s*days?|constantly|everything)\b/i,
      /\bdiarrhoea|diarrhea|cirit/i,
      /\bnot urinating\b/i,
    ],
  },
  {
    id: 'infection_signs',
    level: 'medium',
    mts: 'urgent',
    reason: 'Possible spreading infection',
    patterns: [
      /\b(wound|luka|cut)\b[^.!?]{0,25}\b(pus|nanah|red|swollen|smell|bengkak)\b/i,
      /\bspreading (rash|redness)\b/i,
      /\bswollen\b[^.!?]{0,20}\b(hot|warm|painful)\b/i,
    ],
  },
  {
    id: 'vulnerable_group',
    level: 'medium',
    mts: 'urgent',
    reason: 'Vulnerable patient group — lower threshold applies',
    patterns: [
      /\b(baby|infant|newborn|bayi)\b[^.!?]{0,30}\b(fever|demam|not feeding|crying)\b/i,
      /\b(elderly|warga emas)\b[^.!?]{0,30}\b(fall|confus|weak)\b/i,
      /\bimmunocompromis|chemotherapy|dialysis\b/i,
    ],
  },
];

/* ================================================================
 * ENGINE
 * ================================================================ */

export interface RiskResult {
  level: RiskLevel;
  mts: MtsTier;
  /** rule ids that fired — stored in risk_assessments.rule_hits */
  ruleHits: string[];
  /** human-readable reasons for the clinician view */
  reasons: string[];
  /** true when a HIGH rule fired: halt advice, escalate */
  halt: boolean;
}

const ALL_RULES = [...HIGH_RISK_RULES, ...MEDIUM_RISK_RULES];

/**
 * Assess a single message deterministically.
 * Runs on RAW text (pre-redaction) so clinical signal is intact —
 * this function never sends text anywhere, it only pattern-matches
 * locally.
 */
export function assessDeterministic(text: string): RiskResult {
  const hits: string[] = [];
  const reasons: string[] = [];
  let level: RiskLevel = 'low';
  let mts: MtsTier = 'standard';

  for (const rule of ALL_RULES) {
    if (rule.patterns.some((p) => p.test(text))) {
      hits.push(rule.id);
      reasons.push(rule.reason);
      if (LEVEL_ORDER[rule.level] > LEVEL_ORDER[level]) {
        level = rule.level;
        mts = rule.mts;
      }
    }
  }

  return { level, mts, ruleHits: hits, reasons, halt: level === 'high' };
}

/**
 * Combine the deterministic result with an LLM's opinion.
 * UNION, not intersection: the model can raise the level but never
 * lower it. This is the whole point of the two-layer design.
 */
export function combineWithModel(
  deterministic: RiskResult,
  modelLevel: RiskLevel | null
): RiskResult {
  if (!modelLevel) return deterministic;

  const combined = maxLevel(deterministic.level, modelLevel);
  if (combined === deterministic.level) return deterministic;

  // Model escalated beyond the rules.
  return {
    level: combined,
    mts: combined === 'high' ? 'very_urgent' : 'urgent',
    ruleHits: [...deterministic.ruleHits, 'model_escalation'],
    reasons: [...deterministic.reasons, 'Model flagged higher risk than rules'],
    halt: combined === 'high',
  };
}

/**
 * Assess a whole conversation. Risk is STICKY across the session:
 * a later reassuring message cannot lower an earlier high assessment.
 * (The database trigger enforces this too — belt and braces.)
 */
export function assessConversation(messages: string[]): RiskResult {
  let acc: RiskResult = {
    level: 'low',
    mts: 'standard',
    ruleHits: [],
    reasons: [],
    halt: false,
  };

  for (const m of messages) {
    const r = assessDeterministic(m);
    if (LEVEL_ORDER[r.level] > LEVEL_ORDER[acc.level]) {
      acc = {
        ...r,
        ruleHits: [...new Set([...acc.ruleHits, ...r.ruleHits])],
        reasons: [...new Set([...acc.reasons, ...r.reasons])],
      };
    } else {
      acc.ruleHits = [...new Set([...acc.ruleHits, ...r.ruleHits])];
      acc.reasons = [...new Set([...acc.reasons, ...r.reasons])];
    }
  }

  return acc;
}

export const RULES_FOR_TESTS = { HIGH_RISK_RULES, MEDIUM_RISK_RULES };
