/**
 * PHI Redaction
 * ---------------------------------------------------------------
 * Every piece of user text passes through here BEFORE it reaches a
 * model, an audit log, or any third party. This is deterministic on
 * purpose: we do not ask an LLM to redact PHI, because a model that
 * occasionally misses an IC number is not an acceptable privacy
 * boundary.
 *
 * KNOWN LIMITATION (documented in the Technical Brief, not hidden):
 * pattern-based redaction catches structured identifiers reliably and
 * free-text names unreliably. It cannot catch combination
 * re-identification (rare condition + small town). This is a floor,
 * not a guarantee.
 */

export type RedactionType =
  | 'malaysian_ic'
  | 'phone'
  | 'email'
  | 'passport'
  | 'credit_card'
  | 'name'
  | 'address'
  | 'date_of_birth';

export interface Redaction {
  type: RedactionType;
  start: number;
  end: number;
  /** never stored alongside the redacted text — for tests only */
  original?: string;
}

export interface RedactionResult {
  redacted: string;
  redactions: Redaction[];
}

/** Ordered: most specific patterns first, so they win overlaps. */
const PATTERNS: Array<{ type: RedactionType; re: RegExp }> = [
  // Malaysian IC: YYMMDD-PB-###G  (dashes optional)
  {
    type: 'malaysian_ic',
    re: /\b\d{6}[-\s]?\d{2}[-\s]?\d{4}\b/g,
  },
  // Malaysian passport: A + 8 digits
  {
    type: 'passport',
    re: /\b[A-Z]\d{8}\b/g,
  },
  {
    type: 'email',
    re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g,
  },
  // Malaysian mobile: +60 / 0 prefix, 9-10 digits
  {
    type: 'phone',
    re: /(?:\+?60|0)[\s-]?1\d[\s-]?\d{3,4}[\s-]?\d{4}\b/g,
  },
  {
    type: 'credit_card',
    re: /\b(?:\d{4}[\s-]?){3}\d{4}\b/g,
  },
  // Dates that look like DOB
  {
    type: 'date_of_birth',
    re: /\b(?:0?[1-9]|[12]\d|3[01])[/-](?:0?[1-9]|1[012])[/-](?:19|20)\d{2}\b/g,
  },
  // Street addresses (Malaysian common forms)
  {
    type: 'address',
    re: /\b(?:no\.?\s*\d+[,\s]+)?(?:jalan|lorong|persiaran|lebuh|taman)\s+[\w\s]{2,30}\b/gi,
  },
];

/**
 * Name detection is separate and deliberately conservative.
 * We only redact names in explicit self-identification patterns
 * ("my name is X", "I am X", "saya X") rather than guessing at every
 * capitalised word — over-redaction destroys the clinical signal the
 * triage layer needs ("Panadol" is not a person).
 */
const NAME_PATTERNS: RegExp[] = [
  // Introducer is case-insensitive via explicit classes; the captured
  // name must still start uppercase, so ordinary words aren't redacted.
  /\b(?:[Mm]y name is|[Nn]ama saya|[Ii] am|[Ii]'m|[Tt]his is|[Ss]aya)\s+([A-Z][a-z]+(?:\s+(?:bin|binti|a\/l|a\/p|[A-Z][a-z]+)){0,3})/g,
  // Requires a capitalised name — "Patient: Ahmad" matches,
  // "Patient message: ..." does not.
  /\b(?:[Pp]atient|[Pp]esakit)\s*:\s*([A-Z][a-z]+(?:\s+(?:bin|binti|[A-Z][a-z]+)){0,3})\b/g,
  // "Dr X" / "Encik X" / "Puan X" honorific forms
  /\b(?:dr|doktor|encik|puan|cik|mr|mrs|ms)\.?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/gi,
];

function overlaps(a: Redaction, list: Redaction[]): boolean {
  return list.some((b) => a.start < b.end && b.start < a.end);
}

export function redact(input: string): RedactionResult {
  const found: Redaction[] = [];

  for (const { type, re } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input)) !== null) {
      const r: Redaction = {
        type,
        start: m.index,
        end: m.index + m[0].length,
        original: m[0],
      };
      if (!overlaps(r, found)) found.push(r);
    }
  }

  for (const re of NAME_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input)) !== null) {
      const captured = m[1];
      if (!captured) continue;
      const start = m.index + m[0].indexOf(captured);
      const r: Redaction = {
        type: 'name',
        start,
        end: start + captured.length,
        original: captured,
      };
      if (!overlaps(r, found)) found.push(r);
    }
  }

  found.sort((a, b) => a.start - b.start);

  // Rebuild the string with placeholders.
  let out = '';
  let cursor = 0;
  for (const r of found) {
    out += input.slice(cursor, r.start);
    out += `[${r.type.toUpperCase()}]`;
    cursor = r.end;
  }
  out += input.slice(cursor);

  // Strip `original` before returning — it must never be persisted.
  const safe = found.map(({ type, start, end }) => ({ type, start, end }));

  return { redacted: out, redactions: safe };
}

/**
 * Hard gate. Call this immediately before any outbound model request.
 * Throws rather than degrading: if redaction is broken we stop, we do
 * not send unredacted PHI and log a warning.
 */
export function assertSafeForModel(text: string): void {
  const { redactions } = redact(text);
  if (redactions.length > 0) {
    throw new Error(
      `assertSafeForModel: text still contains ${redactions.length} unredacted identifier(s)`
    );
  }
}
