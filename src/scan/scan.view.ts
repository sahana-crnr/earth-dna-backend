// Response shapes for F1 (how-to.md §4). Built from entities; never exposes
// S3 keys or bucket names — photos are reachable only via short-lived URLs.
import type {
  ScanShoeStatus,
  ScanSource,
  ScanStatus,
  ShoeView,
} from './scan.types';

export interface ScanPhotoView {
  view: ShoeView;
  contentType: string;
  bytes: number | null;
  takenAt: string | null;
  updatedAt: string;
  /** Short-lived signed GET URL (SCAN_PHOTO_URL_TTL_SECONDS). */
  url: string;
}

export interface ScanShoeView {
  id: string;
  position: number;
  label: string;
  status: ScanShoeStatus;
  complete: boolean;
  missing: ShoeView[];
  photos: ScanPhotoView[];
}

export interface ScanSessionView {
  id: string;
  status: ScanStatus;
  source: ScanSource;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  canFinish: boolean;
  shoes: ScanShoeView[];
}

export interface ScanSummaryView {
  id: string;
  status: ScanStatus;
  source: ScanSource;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  shoeCount: number;
  completeShoes: number;
  canFinish: boolean;
}

export interface ScanListView {
  items: ScanSummaryView[];
  total: number;
  limit: number;
  offset: number;
}

export interface AlbumShoeResult {
  ref: string;
  saved: boolean;
  shoeId?: string;
  label?: string;
  complete?: boolean;
  missing?: ShoeView[];
  error?: string;
  detail?: string;
}

export interface AlbumBatchView {
  session: ScanSessionView;
  results: AlbumShoeResult[];
}
