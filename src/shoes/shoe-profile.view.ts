// Response shapes for F5 (features/F5-shoe-profile/decisions.md example).
// One profile view serves E21 and the responses of E22 / E27 / E28.
import type {
  ActionTaken,
  Gender,
  MaterialPart,
  RecommendedAction,
  ScanStatus,
  ShoePhotoSource,
  ShoeView,
  ValueSource,
} from '../scan/scan.types';
import type { ConditionView } from './shoe-profile-rules';

export interface ShoePhotoView {
  id: string;
  source: ShoePhotoSource;
  /** Captured view for scan photos (Figma "Your Scans" label); null for uploads. */
  view: ShoeView | null;
  /** Signed URL (SHOE_PHOTO_URL_TTL_SECONDS); null when signing failed. */
  url: string | null;
  isPrimary: boolean;
  sortOrder: number;
  createdAt: string;
}

export interface MaterialView {
  part: MaterialPart;
  material: string;
  source: ValueSource;
}

export interface ShareStateView {
  active: boolean;
  url: string | null;
  createdAt: string | null;
}

export interface ConditionFeedbackView {
  suggestedConditionCode: string;
  reason: string;
  createdAt: string;
}

export interface ShoeProfileView {
  id: string;
  brand: { id: string | null; name: string };
  subBrand: string | null;
  model: string | null;
  shoeType: { id: string | null; name: string | null };
  category: string | null;
  subCategory: string | null;
  color: string | null;
  size: { id: string | null; label: string | null };
  gender: Gender | null;
  condition: ConditionView;
  /** Latest E30 suggestion, if any (F5-D19). */
  conditionFeedback: ConditionFeedbackView | null;
  material: string | null;
  value: {
    min: number | null;
    max: number | null;
    currency: string;
    demandNote: string | null;
    source: ValueSource;
    version: string | null;
    computedAt: string | null;
  };
  recommendation: { action: RecommendedAction | null; reason: string | null };
  materials: MaterialView[];
  /** Undefined section in the design (F5-D4). */
  circularSort: { status: 'pending' };
  photos: ShoePhotoView[];
  actionTaken: ActionTaken;
  actionTakenAt: string | null;
  share: ShareStateView;
  scan: { scanId: string | null; scanShoeId: string | null };
  /** Open rescan session, if one exists (F5-D21). */
  rescan: { scanId: string; shoeId: string; status: ScanStatus } | null;
  createdAt: string;
  updatedAt: string;
}

/** E24 response. */
export interface ShareLinkView {
  url: string;
  token: string;
  createdAt: string;
}

/** E29 response. */
export interface RescanView {
  scanId: string;
  shoeId: string;
  status: ScanStatus;
  /** false when an open rescan already existed (200 instead of 201). */
  created: boolean;
}
