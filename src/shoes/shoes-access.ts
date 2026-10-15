// Ownership-scoped lookup for My Shoes entries, the F5 twin of
// scan-access.ts: another user's id or a removed entry behaves exactly like a
// missing one — 404, never 403.
import { EntityManager } from 'typeorm';
import { notFound } from '../scan/scan-access';
import { ShoeEntity } from './entities/shoe.entity';

/** The only place a shoe is resolved for its owner. `lock` adds FOR UPDATE. */
export async function findOwnedShoe(
  m: EntityManager,
  userId: string,
  shoeId: string,
  lock = false,
): Promise<ShoeEntity> {
  const qb = m
    .getRepository(ShoeEntity)
    .createQueryBuilder('shoe')
    .where(
      'shoe.id = :shoeId AND shoe.userId = :userId AND shoe.deletedAt IS NULL',
      { shoeId, userId },
    );
  if (lock) qb.setLock('pessimistic_write');
  const shoe = await qb.getOne();
  if (!shoe) throw notFound('SHOE_NOT_FOUND', 'Shoe not found');
  return shoe;
}
