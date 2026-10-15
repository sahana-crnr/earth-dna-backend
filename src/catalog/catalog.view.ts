// Response shapes for the F3 catalog endpoints.
import type { Gender } from '../scan/scan.types';

export interface ListView<T> {
  items: T[];
  /** E15 only: true when the generic US list was returned instead of a per-brand one. */
  generic?: boolean;
}

export interface BrandItemView {
  id: string;
  name: string;
  slug: string;
}

export interface SizeItemView {
  id: string;
  label: string;
  system: string;
}

export interface SubcategoryItemView {
  id: string;
  name: string;
  slug: string;
}

export interface CategoryItemView extends SubcategoryItemView {
  subcategories: SubcategoryItemView[];
}

/** E16 (F5-D20): a Figma shoe type with the product-DB categories under it. */
export interface ShoeTypeItemView {
  id: string;
  name: string;
  slug: string;
  categories: SubcategoryItemView[];
}

export interface ModelItemView {
  model: string;
  modelCode: string | null;
}

export interface ColourItemView {
  colour: string;
}

export interface OptionsView {
  genders: Gender[];
}
