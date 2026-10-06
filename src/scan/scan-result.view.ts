// Response shapes for F2 (Backend API Plan §4). Built from entities; the
// condition label and matchPercent are derived here-and-now by result-rules.ts
// so the app never has to know the mapping or the rounding.
import type {
  ConditionCode,
  IdentificationOutcome,
  IdentificationSource,
  ResultStatus,
  ScanStatus,
} from './scan.types';

export interface ResultCandidateView {
  brand: string;
  model: string | null;
  confidence: number;
}

export interface ShoeResultView {
  source: IdentificationSource;
  outcome: IdentificationOutcome;
  modelVersion: string;
  brand: string | null;
  subBrand: string | null;
  model: string | null;
  colorway: string | null;
  confidence: number | null;
  /** Whole-number percent derived from confidence — what Review Matches shows. */
  matchPercent: number | null;
  /** `label` is PROVISIONAL; only `code` is stored (plan §8, open point 7). */
  condition: { code: ConditionCode | null; label: string | null };
  candidates: ResultCandidateView[];
  /** Omitted entirely unless asked for: always present on E10, on E11 only with
   *  ?include=raw. Absent means "not requested", `null` means "none stored". */
  raw?: Record<string, unknown> | null;
  submittedAt: string;
  updatedAt: string;
}

export interface ShoeResultEntryView {
  shoeId: string;
  position: number;
  label: string;
  status: ResultStatus;
  result: ShoeResultView | null;
}

export interface ScanResultsView {
  scanId: string;
  status: ScanStatus;
  /** True once every shoe has a terminal result; the processing screen stops polling. */
  allResolved: boolean;
  shoes: ShoeResultEntryView[];
}

export interface SubmitResultView {
  shoeId: string;
  label: string;
  /** false on the first submit (201), true on every later one (200). */
  replaced: boolean;
  status: ResultStatus;
  result: ShoeResultView;
  /** Scan status after the submit — flips to 'review' on the last shoe. */
  scanStatus: ScanStatus;
}
