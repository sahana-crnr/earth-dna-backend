// Daily: drafts idle for SCAN_DRAFT_ABANDON_DAYS become 'abandoned' (F1-D9).
// Idempotent UPDATE, so several containers running it at once is harmless.
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ScanService } from './scan.service';

@Injectable()
export class ScanAbandonJob {
  private readonly logger = new Logger(ScanAbandonJob.name);

  constructor(private readonly scans: ScanService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'scan-abandon-drafts' })
  async run(): Promise<void> {
    try {
      const n = await this.scans.abandonStaleDrafts();
      if (n > 0) this.logger.log(`marked ${n} idle draft scan(s) abandoned`);
    } catch (err) {
      this.logger.error(`abandon job failed: ${String(err)}`);
    }
  }
}
