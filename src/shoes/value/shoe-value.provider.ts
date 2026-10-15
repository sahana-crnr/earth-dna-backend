// F5-D15: the boundary between "what a pair is worth" and the rest of the
// backend. Today the only implementation is the static placeholder (F3-D13b);
// a ValueLens implementation lands once the service contract exists (T20,
// F7 settings for URL + version). Callers never know which one answered —
// they read `source` on the result.
import type {
  ConditionCode,
  RecommendedAction,
  ResaleBucket,
  ValueSource,
} from '../../scan/scan.types';

export const SHOE_VALUE_PROVIDER = Symbol('SHOE_VALUE_PROVIDER');

export interface ShoeValueInput {
  /** The My Shoes id (or scan shoe id at review time) — stable per pair. */
  shoeId: string;
  brand: string | null;
  model: string | null;
  conditionCode: ConditionCode | null;
}

export interface ShoeValue {
  recommendedAction: RecommendedAction | null;
  resaleMin: number | null;
  resaleMax: number | null;
  resaleBucket: ResaleBucket | null;
  demandNote: string | null;
  recommendationReason: string | null;
  source: ValueSource;
  version: string | null;
}

export interface ShoeValueProvider {
  valueFor(input: ShoeValueInput): Promise<ShoeValue>;
}
