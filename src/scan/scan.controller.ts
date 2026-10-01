// F1 scan-session endpoints (how-to.md §4, E1–E9). Every route requires the
// EarthDNA JWT; the service scopes every query to the caller.
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UploadedFile,
  UploadedFiles,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor, FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApiError } from '../common/errors/api-error';
import { AlbumBatchBodyDto, AlbumManifestDto } from './dto/album-batch.dto';
import { ListScansQueryDto } from './dto/list-scans-query.dto';
import { UploadPhotoBodyDto, UploadPhotoFormDoc } from './dto/upload-photo.dto';
import { ScanHttpErrorFilter } from './scan-http-error.filter';
import { ScanService } from './scan.service';
import { SHOE_VIEWS, type ShoeView } from './scan.types';
import type {
  AlbumBatchView,
  ScanListView,
  ScanSessionView,
} from './scan.view';
import { ShoeViewPipe } from './shoe-view.pipe';

const uuid = new ParseUUIDPipe({ version: '4' });

@ApiTags('Scans (F1)')
@ApiBearerAuth('access-token')
@ApiResponse({ status: 401, description: 'Missing or invalid access token' })
@ApiResponse({
  status: 404,
  description:
    'SCAN_NOT_FOUND / SHOE_NOT_FOUND / PHOTO_NOT_FOUND (also for ids owned by someone else)',
})
@ApiResponse({ status: 503, description: 'STORAGE_NOT_CONFIGURED' })
@UseGuards(JwtAuthGuard)
@UseFilters(ScanHttpErrorFilter)
@Controller('scans')
export class ScanController {
  constructor(private readonly scans: ScanService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'E1 — create a draft scan session' })
  @ApiResponse({ status: 201, description: 'Session with no shoes' })
  @ApiResponse({
    status: 409,
    description: 'DRAFT_LIMIT_REACHED (only when SCAN_MAX_OPEN_DRAFTS > 0)',
  })
  create(@CurrentUser('sub') userId: string): Promise<ScanSessionView> {
    return this.scans.createDraft(userId);
  }

  @Get()
  @ApiOperation({
    summary: 'E2 — list my scans (newest first); ?status=draft to resume',
  })
  list(
    @CurrentUser('sub') userId: string,
    @Query() q: ListScansQueryDto,
  ): Promise<ScanListView> {
    return this.scans.list(userId, q.status, q.limit ?? 20, q.offset ?? 0);
  }

  @Get(':scanId')
  @ApiOperation({
    summary:
      'E3 — session detail: shoes, captured and missing views, thumbnail URLs',
  })
  get(
    @CurrentUser('sub') userId: string,
    @Param('scanId', uuid) scanId: string,
  ): Promise<ScanSessionView> {
    return this.scans.get(userId, scanId);
  }

  @Post(':scanId/shoes')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'E4 — add the next shoe ("Scan another shoe")' })
  @ApiResponse({ status: 409, description: 'NOT_DRAFT / SHOE_LIMIT_REACHED' })
  addShoe(
    @CurrentUser('sub') userId: string,
    @Param('scanId', uuid) scanId: string,
  ): Promise<ScanSessionView> {
    return this.scans.addShoe(userId, scanId);
  }

  @Delete(':scanId/shoes/:shoeId')
  @ApiOperation({ summary: 'E5 — remove a shoe; the rest are renumbered' })
  @ApiResponse({ status: 409, description: 'NOT_DRAFT' })
  deleteShoe(
    @CurrentUser('sub') userId: string,
    @Param('scanId', uuid) scanId: string,
    @Param('shoeId', uuid) shoeId: string,
  ): Promise<ScanSessionView> {
    return this.scans.deleteShoe(userId, scanId, shoeId);
  }

  @Put(':scanId/shoes/:shoeId/photos/:view')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({
    summary: 'E6 — upload or retake one view (multipart, part name "file")',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: UploadPhotoFormDoc })
  @ApiParam({ name: 'view', enum: SHOE_VIEWS })
  @ApiResponse({
    status: 400,
    description: 'INVALID_VIEW / FILE_REQUIRED / UNEXPECTED_FILE_FIELD',
  })
  @ApiResponse({ status: 409, description: 'NOT_DRAFT' })
  @ApiResponse({ status: 413, description: 'FILE_TOO_LARGE' })
  @ApiResponse({ status: 415, description: 'UNSUPPORTED_TYPE' })
  @ApiResponse({ status: 502, description: 'STORAGE_UNAVAILABLE' })
  uploadPhoto(
    @CurrentUser('sub') userId: string,
    @Param('scanId', uuid) scanId: string,
    @Param('shoeId', uuid) shoeId: string,
    @Param('view', ShoeViewPipe) view: ShoeView,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: UploadPhotoBodyDto,
  ): Promise<ScanSessionView> {
    return this.scans.uploadPhoto(
      userId,
      scanId,
      shoeId,
      view,
      file,
      body.takenAt ? new Date(body.takenAt) : null,
    );
  }

  @Delete(':scanId/shoes/:shoeId/photos/:view')
  @ApiOperation({ summary: 'E7 — delete one view' })
  @ApiParam({ name: 'view', enum: SHOE_VIEWS })
  @ApiResponse({ status: 409, description: 'NOT_DRAFT' })
  deletePhoto(
    @CurrentUser('sub') userId: string,
    @Param('scanId', uuid) scanId: string,
    @Param('shoeId', uuid) shoeId: string,
    @Param('view', ShoeViewPipe) view: ShoeView,
  ): Promise<ScanSessionView> {
    return this.scans.deletePhoto(userId, scanId, shoeId, view);
  }

  @Post(':scanId/photos/batch')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @UseInterceptors(AnyFilesInterceptor())
  @ApiOperation({
    summary:
      'E8 — album upload: up to 3 shoes / 12 photos; valid shoes are saved, invalid ones reported',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: AlbumBatchBodyDto })
  @ApiResponse({
    status: 400,
    description: 'INVALID_MANIFEST / DUPLICATE_FILE_FIELD',
  })
  @ApiResponse({ status: 409, description: 'NOT_DRAFT' })
  @ApiResponse({
    status: 413,
    description:
      'BATCH_TOO_LARGE / FILE_TOO_LARGE (one oversize file aborts the whole upload)',
  })
  async albumBatch(
    @CurrentUser('sub') userId: string,
    @Param('scanId', uuid) scanId: string,
    @Body() body: AlbumBatchBodyDto,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
  ): Promise<AlbumBatchView> {
    const manifest = await parseManifest(body.manifest);
    return this.scans.albumBatch(userId, scanId, manifest.shoes, files ?? []);
  }

  @Post(':scanId/finish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'E9 — finish scanning; every shoe must have all 4 views',
  })
  @ApiResponse({
    status: 409,
    description:
      'NOT_DRAFT / NO_SHOES / SCAN_INCOMPLETE (details.incomplete lists the shoes)',
  })
  finish(
    @CurrentUser('sub') userId: string,
    @Param('scanId', uuid) scanId: string,
  ): Promise<ScanSessionView> {
    return this.scans.finish(userId, scanId);
  }
}

export async function parseManifest(raw: string): Promise<AlbumManifestDto> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_MANIFEST',
      'manifest is not valid JSON',
    );
  }
  const dto = plainToInstance(AlbumManifestDto, json);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  if (errors.length > 0) {
    throw new ApiError(
      HttpStatus.BAD_REQUEST,
      'INVALID_MANIFEST',
      'manifest does not match the expected shape',
      {
        fields: errors.map((e) => e.property),
      },
    );
  }
  return dto;
}
