// Response shapes for My Shoes. `MyShoeView` is the card F3 returns after a
// review and F4 lists, so the two can never disagree about the same entry. The
// condition label is derived (result-rules.ts), never stored; S3 keys never
// leave the server — only the short-lived signed `thumbnailUrl` does.
import type {
  ActionTaken,
  ConditionCode,
  Gender,
  RecommendedAction,
  ResaleBucket,
  ValueSource,
} from '../scan/scan.types';

/** The My Shoes entry as the app shows it (F3 review response, F4 card). */
export interface MyShoeView {
  id: string;
  brand: { id: string | null; name: string };
  subBrand: string | null;
  category: string | null;
  subCategory: string | null;
  model: string | null;
  color: string | null;
  size: { id: string | null; label: string | null };
  gender: Gender | null;
  /** F5-D20: Figma shoe type when the ShoeDNA category mapped. */
  shoeType: { id: string | null; name: string | null };
  condition: { code: ConditionCode | null; label: string | null };
  material: string | null;
  recommendedAction: RecommendedAction | null;
  resale: { min: number | null; max: number | null; currency: string };
  valueSource: ValueSource;
  /** Signed URL of the primary shoe_photos row (F5-D17). */
  thumbnailUrl: string | null;
  primaryPhotoId: string | null;
  createdAt: string;
}

/** E31 item: the card plus the two fields the Filters sheet keys on that the
 *  F3 response has no use for. */
export interface ShoeListItemView extends MyShoeView {
  actionTaken: ActionTaken;
  resaleBucket: ResaleBucket | null;
}

/** E31 — same paging envelope as E2 (`ScanListView`). */
export interface ShoeListView {
  items: ShoeListItemView[];
  total: number;
  limit: number;
  offset: number;
}

/** E32 — My Shoes header (Home no longer shows stats; CO2e dropped 2026-10-09). `null` means "cannot be
 *  computed yet" (no shoe carries the value), which the app renders as a
 *  friendly message rather than a misleading 0. */
export interface ShoeSummaryView {
  pairsScanned: number;
  potentialValue: { min: number; max: number; currency: string } | null;
}
