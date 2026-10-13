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
  condition: { code: ConditionCode | null; label: string | null };
  material: string | null;
  recommendedAction: RecommendedAction | null;
  resale: { min: number | null; max: number | null; currency: string };
  co2eKg: number | null;
  valueSource: ValueSource;
  thumbnailUrl: string | null;
  createdAt: string;
}

/** E20 item: the card plus the two fields the Filters sheet keys on that the
 *  F3 response has no use for. */
export interface ShoeListItemView extends MyShoeView {
  actionTaken: ActionTaken;
  resaleBucket: ResaleBucket | null;
}

/** E20 — same paging envelope as E2 (`ScanListView`). */
export interface ShoeListView {
  items: ShoeListItemView[];
  total: number;
  limit: number;
  offset: number;
}

/** E21 — Home stats card and the My Shoes header. `null` means "cannot be
 *  computed yet" (no shoe carries the value), which the app renders as a
 *  friendly message rather than a misleading 0. */
export interface ShoeSummaryView {
  pairsScanned: number;
  potentialValue: { min: number; max: number; currency: string } | null;
  co2eKg: number | null;
}
