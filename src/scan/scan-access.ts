// Ownership-scoped lookups shared by F1 (scan.service.ts) and F2
// (scan-result.service.ts). Extracted so both services enforce scoping the
// same way: a scan id belonging to someone else behaves exactly like a missing
// one — 404, never 403, so an attacker cannot probe for valid ids.
import { HttpStatus } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { ApiError } from '../common/errors/api-error';
import { ScanEntity } from './entities/scan.entity';
import { ScanPhotoEntity } from './entities/scan-photo.entity';
import { ScanShoeEntity } from './entities/scan-shoe.entity';

export type ShoeWithPhotos = ScanShoeEntity & { photos: ScanPhotoEntity[] };

export function notFound(code: string, message: string): ApiError {
  return new ApiError(HttpStatus.NOT_FOUND, code, message);
}

/** The only place a scan is resolved. `lock` adds SELECT … FOR UPDATE. */
export async function findOwnedScan(
  m: EntityManager,
  userId: string,
  scanId: string,
  lock = false,
): Promise<ScanEntity> {
  const qb = m
    .getRepository(ScanEntity)
    .createQueryBuilder('scan')
    .where('scan.id = :scanId AND scan.userId = :userId', { scanId, userId });
  if (lock) qb.setLock('pessimistic_write');
  const scan = await qb.getOne();
  if (!scan) throw notFound('SCAN_NOT_FOUND', 'Scan not found');
  return scan;
}

export async function loadShoes(
  m: EntityManager,
  scanIds: string[],
): Promise<ShoeWithPhotos[]> {
  const shoes = await m
    .getRepository(ScanShoeEntity)
    .createQueryBuilder('shoe')
    .leftJoinAndSelect('shoe.photos', 'photo')
    .where('shoe.scanId IN (:...scanIds)', { scanIds })
    .orderBy('shoe.position', 'ASC')
    .getMany();
  return shoes.map((s) => ({ ...s, photos: s.photos ?? [] }));
}

/** Bumps updatedAt so "resume" ordering and the abandon sweep see the change. */
export async function touchScan(
  m: EntityManager,
  scanId: string,
): Promise<void> {
  await m
    .createQueryBuilder()
    .update(ScanEntity)
    .set({ updatedAt: () => 'now()' })
    .where('id = :scanId', { scanId })
    .execute();
}
