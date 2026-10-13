// F5 owner endpoints E21–E25, E27–E30 under /shoes. Same conventions as the
// scan controllers: JWT guard, ScanHttpErrorFilter for Multer errors, 404 for
// ids owned by someone else, per-route throttles above the global default.
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UploadPhotoFormDoc } from '../scan/dto/upload-photo.dto';
import { ScanHttpErrorFilter } from '../scan/scan-http-error.filter';
import { ConditionFeedbackDto } from './dto/condition-feedback.dto';
import { UpdateShoeDto } from './dto/update-shoe.dto';
import type {
  ConditionFeedbackView,
  RescanView,
  ShareLinkView,
  ShoeProfileView,
} from './shoe-profile.view';
import { ShoesService } from './shoes.service';

const uuid = new ParseUUIDPipe({ version: '4' });

/**
 * API base of the current request ("http://host/api/v1"), derived from the
 * URL itself so no config has to know the public host. `marker` is the first
 * path segment after the prefix ("/shoes", "/s").
 */
export function apiBaseOf(req: Request, marker: string): string {
  const url = req.originalUrl ?? req.url ?? '';
  const idx = url.indexOf(marker);
  const prefix = idx >= 0 ? url.slice(0, idx) : '';
  const proto =
    req.get('x-forwarded-proto')?.split(',')[0].trim() || req.protocol;
  return `${proto}://${req.get('host') ?? 'localhost'}${prefix}`;
}

@ApiTags('My Shoes (F5)')
@ApiBearerAuth('access-token')
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
@ApiResponse({
  status: 404,
  description: 'SHOE_NOT_FOUND (also for ids owned by someone else or removed)',
})
@UseGuards(JwtAuthGuard)
@UseFilters(ScanHttpErrorFilter)
@Throttle({ default: { limit: 60, ttl: 60000 } })
@Controller('shoes')
export class ShoesController {
  constructor(private readonly shoes: ShoesService) {}

  @Get(':shoeId')
  @ApiOperation({
    summary: 'E21 — full Shoe Profile in one call',
    description:
      'Identity, photos (signed URLs), condition grade / label / copy, resale range, recommendation, material profile, CircularSort placeholder, action taken, share state, origin scan and open rescan.',
  })
  profile(
    @CurrentUser('sub') userId: string,
    @Param('shoeId', uuid) shoeId: string,
    @Req() req: Request,
  ): Promise<ShoeProfileView> {
    return this.shoes.getProfile(userId, shoeId, this.base(req));
  }

  @Patch(':shoeId')
  @ApiOperation({
    summary: 'E22 — edit shoe details',
    description:
      'brandId, model, color, sizeId, shoeTypeId, gender, actionTaken, primaryPhotoId — all optional, at least one. Brand / model / colour / size changes re-run the silent catalog product match; a brand change recomputes the placeholder value. Condition is not editable (use condition-feedback).',
  })
  @ApiResponse({
    status: 400,
    description:
      'validation / EMPTY_UPDATE / UNKNOWN_BRAND / UNKNOWN_SIZE / UNKNOWN_SHOE_TYPE / UNKNOWN_PHOTO',
  })
  update(
    @CurrentUser('sub') userId: string,
    @Param('shoeId', uuid) shoeId: string,
    @Body() dto: UpdateShoeDto,
    @Req() req: Request,
  ): Promise<ShoeProfileView> {
    return this.shoes.update(userId, shoeId, dto, this.base(req));
  }

  @Delete(':shoeId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'E23 — remove shoe (soft delete)',
    description:
      'The entry leaves My Shoes, its share link stops working and the origin scan is hidden once every shoe of that session is removed. Photos and training rows are kept server-side.',
  })
  @ApiResponse({ status: 204, description: 'Removed' })
  async remove(
    @CurrentUser('sub') userId: string,
    @Param('shoeId', uuid) shoeId: string,
  ): Promise<void> {
    await this.shoes.remove(userId, shoeId);
  }

  @Post(':shoeId/share')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOperation({
    summary: 'E24 — create (or return) the public share link',
    description:
      '201 with a new link, 200 when an active link already exists. Links never expire; revoke with DELETE.',
  })
  @ApiResponse({ status: 201, description: '{ url, token, createdAt }' })
  @ApiResponse({ status: 200, description: 'Existing link' })
  async share(
    @CurrentUser('sub') userId: string,
    @Param('shoeId', uuid) shoeId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ShareLinkView> {
    const { created, link } = await this.shoes.createShare(
      userId,
      shoeId,
      this.base(req),
    );
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return link;
  }

  @Delete(':shoeId/share')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'E25 — revoke the share link (204 even when none)' })
  async revokeShare(
    @CurrentUser('sub') userId: string,
    @Param('shoeId', uuid) shoeId: string,
  ): Promise<void> {
    await this.shoes.revokeShare(userId, shoeId);
  }

  @Post(':shoeId/photos')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({
    summary: 'E27 — add a photo (multipart, part name "file")',
    description:
      'Same size / type rules as the F1 scan upload. Up to SHOE_MAX_PHOTOS (8) photos per shoe, scan views included. The first photo of a shoe without one becomes the main photo.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadPhotoFormDoc })
  @ApiResponse({ status: 201, description: 'Profile view with the new photo' })
  @ApiResponse({
    status: 400,
    description: 'FILE_REQUIRED / UNEXPECTED_FILE_FIELD',
  })
  @ApiResponse({ status: 409, description: 'PHOTO_LIMIT_REACHED' })
  @ApiResponse({ status: 413, description: 'FILE_TOO_LARGE' })
  @ApiResponse({ status: 415, description: 'UNSUPPORTED_TYPE' })
  @ApiResponse({ status: 502, description: 'STORAGE_UNAVAILABLE' })
  uploadPhoto(
    @CurrentUser('sub') userId: string,
    @Param('shoeId', uuid) shoeId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: Request,
  ): Promise<ShoeProfileView> {
    return this.shoes.uploadPhoto(userId, shoeId, file, this.base(req));
  }

  @Delete(':shoeId/photos/:photoId')
  @ApiOperation({
    summary: 'E28 — remove a photo',
    description:
      'A shoe keeps at least one photo (409 LAST_PHOTO). Removing the main photo promotes the next one. Uploaded objects are deleted from storage; scan photos stay with their scan.',
  })
  @ApiResponse({ status: 200, description: 'Profile view' })
  @ApiResponse({ status: 404, description: 'SHOE_NOT_FOUND / PHOTO_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'LAST_PHOTO' })
  deletePhoto(
    @CurrentUser('sub') userId: string,
    @Param('shoeId', uuid) shoeId: string,
    @Param('photoId', uuid) photoId: string,
    @Req() req: Request,
  ): Promise<ShoeProfileView> {
    return this.shoes.deletePhoto(userId, shoeId, photoId, this.base(req));
  }

  @Post(':shoeId/rescan')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOperation({
    summary: 'E29 — rescan: new draft scan linked to this entry',
    description:
      '201 with the new scanId + shoeId (continue with the F1 upload endpoints); 200 with the existing one when a rescan is still open. When that scan is reviewed (F3) the entry is updated in place.',
  })
  @ApiResponse({
    status: 201,
    description: '{ scanId, shoeId, status, created }',
  })
  @ApiResponse({ status: 409, description: 'DRAFT_LIMIT_REACHED' })
  @ApiResponse({ status: 503, description: 'STORAGE_NOT_CONFIGURED' })
  async rescan(
    @CurrentUser('sub') userId: string,
    @Param('shoeId', uuid) shoeId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<RescanView> {
    const view = await this.shoes.rescan(userId, shoeId);
    res.status(view.created ? HttpStatus.CREATED : HttpStatus.OK);
    return view;
  }

  @Post(':shoeId/condition-feedback')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOperation({
    summary: 'E30 — suggest a different condition (training feedback)',
    description:
      'Stores the suggestion and reason; the assessment on the shoe does not change.',
  })
  @ApiResponse({
    status: 201,
    description: '{ suggestedConditionCode, reason, createdAt }',
  })
  suggestCondition(
    @CurrentUser('sub') userId: string,
    @Param('shoeId', uuid) shoeId: string,
    @Body() dto: ConditionFeedbackDto,
  ): Promise<ConditionFeedbackView> {
    return this.shoes.suggestCondition(userId, shoeId, dto);
  }

  private base(req: Request): string {
    return this.shoes.shareBase(apiBaseOf(req, '/shoes'));
  }
}
