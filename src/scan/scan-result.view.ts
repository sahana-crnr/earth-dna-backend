// Response shapes for F2 (Backend API Plan §4). Built from entities; the
// condition label and matchPercent are derived here-and-now by result-rules.ts
// so the app never has to know the mapping or the rounding.
import type {
  ConditionCode,
  IdentificationOutcome,
  IdentificationSource,
  ResultStatus,
  ReviewState,
  ScanStatus,
} from './scan.types';
import type { MyShoeView } from '../shoes/shoes.view';

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
  /** F3-D18: taxonomy level and material as ShoeDNA reported them. */
  category: string | null;
  subCategory: string | null;
  material: string | null;
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

/** F3: the My Shoes entry a review created; the shape lives with the shoes
 *  module, which F4 lists through the same mapper (ShoeViewMapper). */
export type { MyShoeView };

export interface ShoeResultEntryView {
  shoeId: string;
  position: number;
  label: string;
  status: ResultStatus;
  result: ShoeResultView | null;
  /** F3: null until the user confirms or rejects this shoe. */
  review: ReviewState | null;
  myShoeId: string | null;
  myShoe: MyShoeView | null;
  /** F3: the predicted brand resolved against the catalog, for the dropdown prefill. */
  suggested: { brandId: string | null; brand: string | null };
}

export interface ScanResultsView {
  scanId: string;
  status: ScanStatus;
  /** True once every shoe has a terminal result; the processing screen stops polling. */
  allResolved: boolean;
  /** F3: "N of M reviewed" for this session (F3-D10). */
  reviewed: { done: number; total: number };
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
