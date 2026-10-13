// F4 + F6 reads over `shoes` (E20 list, E21 summary). Read-only: F3 creates
// the rows, F5 will edit and soft-delete them. Every query is scoped by userId
// and excludes soft-deleted rows, and the list and summary share that one
// population so the "N pairs" header always matches the list total.
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, IsNull, Repository } from 'typeorm';
import { ListShoesQueryDto } from './dto/list-shoes-query.dto';
import { ShoeEntity } from './entities/shoe.entity';
import { ShoeViewMapper } from './shoe-view.mapper';
import {
  codesForConditions,
  toSummary,
  type SummaryAggregate,
} from './shoes-rules';
import type { ShoeListView, ShoeSummaryView } from './shoes.view';

@Injectable()
export class ShoesService {
  constructor(
    @InjectRepository(ShoeEntity)
    private readonly shoes: Repository<ShoeEntity>,
    private readonly views: ShoeViewMapper,
  ) {}

  async list(userId: string, q: ListShoesQueryDto): Promise<ShoeListView> {
    const limit = q.limit ?? 20;
    const offset = q.offset ?? 0;
    const where: FindOptionsWhere<ShoeEntity> = { userId, deletedAt: IsNull() };
    if (q.actionTaken?.length) where.actionTaken = In(q.actionTaken);
    if (q.condition?.length)
      where.conditionCode = In(codesForConditions(q.condition));
    if (q.recommendedAction?.length)
      where.recommendedAction = In(q.recommendedAction);
    if (q.resaleBucket?.length) where.resaleBucket = In(q.resaleBucket);

    const [rows, total] = await this.shoes.findAndCount({
      where,
      // `id` tiebreaker keeps pages stable when createdAt values collide.
      order: { createdAt: 'DESC', id: 'DESC' },
      take: limit,
      skip: offset,
    });
    // Signing is the only async step per row; run them together.
    const items = await Promise.all(
      rows.map(async (e) => ({
        ...(await this.views.toMyShoeView(e)),
        actionTaken: e.actionTaken,
        resaleBucket: e.resaleBucket,
      })),
    );
    return { items, total, limit, offset };
  }

  /**
   * One aggregate pass. Potential value counts only pairs still waiting for an
   * action (`actionTaken = 'none'`) — a resold or recycled pair no longer
   * holds that value — and only pairs with a full range, since half a range is
   * not a value. CO2e counts every pair the user has.
   */
  async summary(userId: string): Promise<ShoeSummaryView> {
    const open = `s."actionTaken" = 'none' AND s."resaleMin" IS NOT NULL AND s."resaleMax" IS NOT NULL`;
    const agg = await this.shoes
      .createQueryBuilder('s')
      .select('COUNT(*)', 'pairs')
      .addSelect(`COUNT(*) FILTER (WHERE ${open})`, 'valueCount')
      .addSelect(`SUM(s."resaleMin") FILTER (WHERE ${open})`, 'valueMin')
      .addSelect(`SUM(s."resaleMax") FILTER (WHERE ${open})`, 'valueMax')
      .addSelect('COUNT(s."co2eKg")', 'co2eCount')
      .addSelect('SUM(s."co2eKg")', 'co2eKg')
      .where('s."userId" = :userId', { userId })
      .andWhere('s."deletedAt" IS NULL')
      .getRawOne<SummaryAggregate>();
    return toSummary(
      agg ?? {
        pairs: 0,
        valueCount: 0,
        valueMin: null,
        valueMax: null,
        co2eCount: 0,
        co2eKg: null,
      },
    );
  }
}
