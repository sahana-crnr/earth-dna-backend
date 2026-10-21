// Pure F2 identification rules (Backend API Plan §4, "F2 — Identification
// results"). No Nest, TypeORM or AWS imports, so every function here can be
// property-tested directly, exactly like scan-rules.ts for F1.
import {
  CONDITION_CODES,
  type ConditionCode,
  type IdentificationOutcome,
  type ResultStatus,
} from './scan.types';

// ─── F2-P1: condition labels ─────────────────────────────────────────────────

/**
 * PROVISIONAL (plan §8, open point 7). Design has not settled on one scale —
 * the Figma shows three (grade letters on Shoe Profile, Great/Good/Fair/Poor in
 * Filters, these four on Review). Five codes therefore map onto four labels and
 * C3/C4 currently share one. Only the raw code is stored, so confirming the
 * scale is an edit to this map and never a migration.
 */
export const CONDITION_LABELS: Record<ConditionCode, string> = {
  C1: 'Like New',
  C2: 'Lightly Worn',
  C3: 'Heavily Worn',
  C4: 'Heavily Worn',
  C5: 'Not wearable',
};

/** Total over ConditionCode; null in, null out. */
export function conditionLabelFor(code: ConditionCode | null): string | null {
  if (code === null) return null;
  return CONDITION_LABELS[code] ?? null;
}

export function isConditionCode(v: unknown): v is ConditionCode {
  return (
    typeof v === 'string' && (CONDITION_CODES as readonly string[]).includes(v)
  );
}

// ─── F2-P2: match percent ────────────────────────────────────────────────────

/**
 * 0.9234 → 92. The Review Matches screen shows a whole number, so the rounding
 * lives here rather than in the app: two clients must never disagree about what
 * the same stored confidence means. Clamped because `confidence` arrives from a
 * client and the DB CHECK is the only other guard.
 */
export function matchPercent(confidence: number | null): number | null {
  if (confidence === null || !Number.isFinite(confidence)) return null;
  const pct = Math.round(confidence * 100);
  return Math.min(100, Math.max(0, pct));
}

// ─── F2-P3: per-shoe status for the processing screen ────────────────────────

/**
 * A stored result always wins: after F3 the shoe row reads `confirmed` or
 * `rejected`, which says nothing about whether identification succeeded, so the
 * outcome recorded on the result row is what the processing screen reports.
 * Without a result there is nothing to report but `waiting` — identification
 * runs on the device, so the server never observes an in-flight attempt.
 */
export function resultStatusFor(
  outcome: IdentificationOutcome | null,
): ResultStatus {
  return outcome ?? 'waiting';
}

// ─── F2-P4: candidate list ───────────────────────────────────────────────────

export interface ResultCandidate {
  brand: string;
  model: string | null;
  confidence: number;
}

export type CandidateRejection =
  | 'TOO_MANY_CANDIDATES'
  | 'DUPLICATE_CANDIDATE'
  | 'CONFIDENCE_OUT_OF_RANGE';

export type CandidateDecision =
  | { ok: true; candidates: ResultCandidate[] }
  | { ok: false; error: CandidateRejection; detail: string };

/** brand+model identity, case- and whitespace-insensitive. */
export function candidateKey(c: {
  brand: string;
  model?: string | null;
}): string {
  return JSON.stringify([
    c.brand.trim().toLowerCase(),
    (c.model ?? '').trim().toLowerCase(),
  ]);
}

/** Human-readable name for an error detail. */
function candidateName(c: { brand: string; model?: string | null }): string {
  return c.model ? `${c.brand} ${c.model}` : c.brand;
}

/** Decimal places of the `confidence` numeric(5,4) column. */
export const CONFIDENCE_DP = 4;

/** Half-up to CONFIDENCE_DP, so a candidate reads back the way the top-level
 *  confidence does after its round trip through Postgres. */
export function roundConfidence(confidence: number): number {
  const scale = 10 ** CONFIDENCE_DP;
  return Math.round(confidence * scale) / scale;
}

/**
 * Validates and canonically orders the ranked candidates (plan §4 F2: "top-3").
 *
 * Over-length is REJECTED rather than truncated: silently dropping the tail
 * would make the stored list disagree with what the model actually ranked.
 * The sort is a total order (confidence desc, then brand, then model) so the
 * result depends only on the SET of candidates and never on the order they were
 * sent in — two clients submitting the same three candidates store identical
 * rows, which is what makes a retry a true no-op.
 *
 * Confidences are rounded to CONFIDENCE_DP first, matching the numeric(5,4)
 * column the top-level `confidence` lands in: the candidates live in jsonb,
 * which would otherwise keep every digit the client sent and put two different
 * precisions in one response. Rounding happens BEFORE the sort so the ordering
 * is a function of the stored values — sorting on raw confidences could order
 * two candidates that round to the same number by a difference the response
 * never shows.
 */
export function normalizeCandidates(
  raw: readonly { brand: string; model?: string | null; confidence: number }[],
  max: number,
): CandidateDecision {
  if (raw.length > max) {
    return {
      ok: false,
      error: 'TOO_MANY_CANDIDATES',
      detail: `at most ${max} candidates, got ${raw.length}`,
    };
  }
  for (const c of raw) {
    if (
      !Number.isFinite(c.confidence) ||
      c.confidence < 0 ||
      c.confidence > 1
    ) {
      return {
        ok: false,
        error: 'CONFIDENCE_OUT_OF_RANGE',
        detail: `candidate '${candidateName(c)}' has confidence ${c.confidence}`,
      };
    }
  }
  const seen = new Set<string>();
  for (const c of raw) {
    const key = candidateKey(c);
    if (seen.has(key)) {
      return {
        ok: false,
        error: 'DUPLICATE_CANDIDATE',
        detail: `'${candidateName(c)}' appears twice`,
      };
    }
    seen.add(key);
  }
  const candidates = raw
    .map((c) => ({
      brand: c.brand,
      model: c.model ?? null,
      confidence: roundConfidence(c.confidence),
    }))
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        cmp(a.brand, b.brand) ||
        cmp(a.model ?? '', b.model ?? ''),
    );
  return { ok: true, candidates };
}

/**
 * Code-unit comparison, not localeCompare: the tiebreak must be a TOTAL order
 * and independent of the server's locale, or two nodes could store the same
 * candidates in different orders and a retry would stop looking like a no-op.
 */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ─── F2-P5: the `raw` passthrough blob ───────────────────────────────────────

export type RawRejection = 'RAW_TOO_LARGE' | 'RAW_TOO_DEEP';

/**
 * The ShoeDNA output contract is still open (plan §8, open point 1), so the
 * endpoint accepts a free-form `raw` object and stores it verbatim rather than
 * forcing a migration per new field. Both guards exist because that object is
 * unvalidated client input: the size cap keeps it away from the Postgres row
 * limit, and the depth cap stops a deeply nested blob from costing far more to
 * serialise than it did to send.
 */
export function checkRawPayload(
  raw: unknown,
  maxBytes: number,
  maxDepth = 6,
): RawRejection | null {
  if (raw === null || raw === undefined) return null;
  if (depthOf(raw, maxDepth) > maxDepth) return 'RAW_TOO_DEEP';
  if (Buffer.byteLength(JSON.stringify(raw) ?? '', 'utf8') > maxBytes) {
    return 'RAW_TOO_LARGE';
  }
  return null;
}

/** Depth of nested objects/arrays; stops counting once `cap` is exceeded. */
function depthOf(value: unknown, cap: number, depth = 1): number {
  if (depth > cap || typeof value !== 'object' || value === null) return depth;
  const children = Array.isArray(value) ? value : Object.values(value);
  let deepest = depth;
  for (const child of children) {
    if (typeof child !== 'object' || child === null) continue;
    deepest = Math.max(deepest, depthOf(child, cap, depth + 1));
    if (deepest > cap) return deepest;
  }
  return deepest;
}
