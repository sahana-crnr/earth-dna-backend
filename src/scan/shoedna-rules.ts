// Server-side ShoeDNA (analyze) — pure request/response rules. No Nest, HTTP
// or AWS imports, same contract as scan-rules.ts / result-rules.ts.
//
// ⚠ ASSUMED CONTRACT. The ShoeDNA HTTP contract is still open (plan §8, open
// point 1). Until it is fixed, the backend assumes:
//
//   POST {baseUrl}/identify
//   { "scanId", "shoeId", "photos": [{ "view", "url", "contentType" }] }
//   → 200 { "modelVersion", "outcome"?, "brand", "subBrand", "model",
//           "colorway", "category", "subCategory", "material", "confidence",
//           "conditionCode", "candidates": [{ "brand", "model", "confidence" }] }
//
// i.e. the E10 body the app already sends, minus `raw`. When the real contract
// lands, this file (and the path in shoedna.client.ts) is the only place to
// change; everything downstream consumes ResultFields.
//
// Strictness differs from E10 on purpose. E10 rejects a malformed body with a
// 400 because the client can fix it; here nobody can, so:
//   - a wrong TYPE or an over-long string is still a failure (the model said
//     something we cannot store faithfully → 502 INFERENCE_FAILED);
//   - too many / duplicate candidates are trimmed to the top-ranked distinct
//     ones rather than failing the whole inference;
//   - an oversized or too-deep body is simply not kept as `raw`.
import type { ShoeView } from './scan.types';
import {
  candidateKey,
  checkRawPayload,
  isConditionCode,
  normalizeCandidates,
  type ResultCandidate,
} from './result-rules';
import type { ResultFields } from './scan-result.service';

export interface ShoeDnaPhoto {
  view: ShoeView;
  url: string;
  contentType: string;
}

export interface ShoeDnaRequest {
  scanId: string;
  shoeId: string;
  photos: ShoeDnaPhoto[];
}

export type ShoeDnaMapping =
  | { ok: true; fields: ResultFields; rawDropped: boolean }
  | { ok: false; reason: string };

/** Same alphabet the E10 DTO enforces, so device and server rows compare. */
const MODEL_VERSION = /^[A-Za-z0-9._@/-]{1,64}$/;
export const FALLBACK_MODEL_VERSION = 'shoedna-server';

/** varchar lengths of scan_shoe_results (and the E10 DTO caps). */
const LIMITS = {
  brand: 120,
  subBrand: 120,
  model: 160,
  colorway: 120,
  category: 100,
  subCategory: 100,
  material: 200,
} as const;
type TextField = keyof typeof LIMITS;

/**
 * Maps a ShoeDNA response body to the result row. `versionFallback` is the F7
 * integration's `version`, used when the body carries no usable modelVersion.
 */
export function mapShoeDnaResponse(
  body: unknown,
  opts: {
    maxCandidates: number;
    rawMaxBytes: number;
    versionFallback: string | null;
  },
): ShoeDnaMapping {
  if (!isRecord(body)) return fail('response is not a JSON object');

  const text = {} as Record<TextField, string | null>;
  for (const key of Object.keys(LIMITS) as TextField[]) {
    const v = optionalText(body[key], LIMITS[key]);
    if (v === undefined)
      return fail(`${key} is not a string of ≤${LIMITS[key]} chars`);
    text[key] = v;
  }

  const confidence = body.confidence ?? null;
  if (confidence !== null && !isUnit(confidence)) {
    return fail('confidence is not a number in 0..1');
  }

  const conditionCode = body.conditionCode ?? null;
  if (conditionCode !== null && !isConditionCode(conditionCode)) {
    return fail('conditionCode is not one of C1..C5');
  }

  const candidates = mapCandidates(body.candidates, opts.maxCandidates);
  if (typeof candidates === 'string') return fail(candidates);

  // 'identified' needs what E10 needs (RESULT_INCOMPLETE): brand + confidence.
  // An explicit 'failed' from the model wins over anything else it sent.
  const outcome =
    body.outcome !== 'failed' && text.brand && confidence !== null
      ? 'identified'
      : 'failed';

  const rawOk = checkRawPayload(body, opts.rawMaxBytes) === null;
  return {
    ok: true,
    rawDropped: !rawOk,
    fields: {
      source: 'server',
      outcome,
      modelVersion: pickModelVersion(body.modelVersion, opts.versionFallback),
      ...text,
      confidence,
      conditionCode,
      candidates,
      raw: rawOk ? body : null,
    },
  };
}

/** Top `max` distinct candidates by confidence, then E10's canonical order. */
function mapCandidates(
  value: unknown,
  max: number,
): ResultCandidate[] | string {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return 'candidates is not an array';

  const parsed: { brand: string; model: string | null; confidence: number }[] =
    [];
  for (const c of value) {
    if (!isRecord(c)) return 'a candidate is not an object';
    const brand = optionalText(c.brand, LIMITS.brand);
    const model = optionalText(c.model, LIMITS.model);
    if (!brand) return 'a candidate has no valid brand';
    if (model === undefined) return 'a candidate has an invalid model';
    if (!isUnit(c.confidence)) return 'a candidate confidence is not in 0..1';
    parsed.push({ brand, model, confidence: c.confidence });
  }

  // Highest confidence first; the first occurrence of a brand+model wins.
  const seen = new Set<string>();
  const top = [...parsed]
    .sort((a, b) => b.confidence - a.confidence)
    .filter((c) => {
      const key = candidateKey(c);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, max);

  const decision = normalizeCandidates(top, max);
  return decision.ok ? decision.candidates : decision.detail;
}

function pickModelVersion(value: unknown, fallback: string | null): string {
  if (typeof value === 'string' && MODEL_VERSION.test(value)) return value;
  if (fallback && MODEL_VERSION.test(fallback)) return fallback;
  return FALLBACK_MODEL_VERSION;
}

/** null/absent → null; a non-empty string within `max` → trimmed; else undefined. */
function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (v.length > max) return undefined;
  return v || null;
}

function isUnit(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function fail(reason: string): ShoeDnaMapping {
  return { ok: false, reason };
}
