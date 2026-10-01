// Validates the :view route param against the four capture views.
import { HttpStatus, Injectable, PipeTransform } from '@nestjs/common';
import { ApiError } from '../common/errors/api-error';
import { SHOE_VIEWS, isShoeView, type ShoeView } from './scan.types';

@Injectable()
export class ShoeViewPipe implements PipeTransform<string, ShoeView> {
  transform(value: string): ShoeView {
    if (!isShoeView(value)) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        'INVALID_VIEW',
        `view must be one of: ${SHOE_VIEWS.join(', ')}`,
      );
    }
    return value;
  }
}
