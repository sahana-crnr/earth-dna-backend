// The F3 placeholder behind the provider interface: deterministic per id so a
// pair never changes value between reads (F3-D13b). Brand, model and
// condition are ignored on purpose — there is no model to feed them to yet.
import { Injectable } from '@nestjs/common';
import { placeholderFor } from '../../scan/review-rules';
import type {
  ShoeValue,
  ShoeValueInput,
  ShoeValueProvider,
} from './shoe-value.provider';

@Injectable()
export class StaticValueProvider implements ShoeValueProvider {
  valueFor(input: ShoeValueInput): Promise<ShoeValue> {
    const p = placeholderFor(input.shoeId);
    return Promise.resolve({
      recommendedAction: p.recommendedAction,
      resaleMin: p.resaleMin,
      resaleMax: p.resaleMax,
      resaleBucket: p.resaleBucket,
      demandNote: p.demandNote,
      recommendationReason: p.recommendationReason,
      source: 'static',
      version: null,
    });
  }
}
