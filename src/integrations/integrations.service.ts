// F7 integration settings: admin reads/edits, plus getActive() for the code
// that will call ShoeDNA (server-side, F2) and ValueLens (F5). This service
// stores settings only - it never calls either endpoint.
//
// Rows are seeded by the CreateIntegrations migration, but local DB_SYNC
// databases never run migrations, so every entry point first inserts any
// missing name with ON CONFLICT DO NOTHING. On a migrated database that is a
// no-op.
//
// update() follows F1's inDraftTx shape: row lock, merge, validate, write, and
// the response read inside the same transaction. The lock matters even with a
// single admin - two browser tabs saving at once would otherwise merge onto
// the same stale row and silently drop one edit.
import { HttpStatus, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { ApiError } from '../common/errors/api-error';
import { IntegrationEntity } from './entities/integration.entity';
import {
  INTEGRATION_NAMES,
  isIntegrationName,
  type IntegrationName,
} from './integration.types';
import {
  applyUpdate,
  incompleteReason,
  settingsEqual,
  type IntegrationPatch,
} from './integration-rules';
import type {
  ActiveIntegration,
  IntegrationListView,
  IntegrationView,
} from './integration.view';

@Injectable()
export class IntegrationsService {
  constructor(private readonly dataSource: DataSource) {}

  async list(): Promise<IntegrationListView> {
    const m = this.dataSource.manager;
    await this.ensureRows(m);
    const rows = await m.getRepository(IntegrationEntity).find({
      relations: { updatedBy: true },
      order: { name: 'ASC' },
    });
    return { items: rows.map(toView) };
  }

  async update(
    name: string,
    patch: IntegrationPatch,
    adminId: string,
  ): Promise<IntegrationView> {
    if (!isIntegrationName(name)) throw notFound(name);

    return this.dataSource.transaction(async (m) => {
      await this.ensureRows(m);
      const repo = m.getRepository(IntegrationEntity);

      // No relations here: FOR UPDATE cannot lock the nullable side of the
      // LEFT JOIN a relation would add.
      const row = await repo.findOne({
        where: { name },
        lock: { mode: 'pessimistic_write' },
      });
      if (!row) throw notFound(name);

      const next = applyUpdate(row, patch);
      const reason = incompleteReason(next);
      if (reason) {
        throw new ApiError(
          HttpStatus.CONFLICT,
          'INTEGRATION_INCOMPLETE',
          reason,
          { name },
        );
      }

      // Re-sending the stored values is a true no-op: updatedBy/updatedAt
      // keep pointing at the change that actually happened.
      if (!settingsEqual(row, next)) {
        await repo.update({ name }, { ...next, updatedById: adminId });
      }

      const saved = await repo.findOneOrFail({
        where: { name },
        relations: { updatedBy: true },
      });
      return toView(saved);
    });
  }

  /** Settings for an enabled integration, or null when it is switched off. */
  async getActive(name: IntegrationName): Promise<ActiveIntegration | null> {
    const row = await this.dataSource
      .getRepository(IntegrationEntity)
      .findOne({ where: { name, enabled: true } });
    if (!row || !row.baseUrl) return null;
    return {
      name: row.name,
      baseUrl: row.baseUrl,
      version: row.version,
      authRef: row.authRef,
    };
  }

  private async ensureRows(m: EntityManager): Promise<void> {
    await m
      .createQueryBuilder()
      .insert()
      .into(IntegrationEntity)
      .values(INTEGRATION_NAMES.map((name) => ({ name })))
      .orIgnore()
      .execute();
  }
}

function notFound(name: string): ApiError {
  return new ApiError(
    HttpStatus.NOT_FOUND,
    'INTEGRATION_NOT_FOUND',
    `Unknown integration "${name}"`,
    { known: [...INTEGRATION_NAMES] },
  );
}

function toView(row: IntegrationEntity): IntegrationView {
  return {
    name: row.name,
    baseUrl: row.baseUrl,
    version: row.version,
    authRef: row.authRef,
    enabled: row.enabled,
    updatedAt: row.updatedAt.toISOString(),
    updatedBy: row.updatedBy
      ? { id: row.updatedBy.id, email: row.updatedBy.email }
      : null,
  };
}
