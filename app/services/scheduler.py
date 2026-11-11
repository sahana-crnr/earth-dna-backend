"""In-process scheduled jobs (replaces @nestjs/schedule): the daily draft
abandon pass at 03:00 UTC, as `CronExpression.EVERY_DAY_AT_3AM` ran in the
container."""

from __future__ import annotations

import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from app.services.scan import ScanService

log = logging.getLogger("app.jobs")


async def abandon_drafts(scans: ScanService) -> None:
    try:
        n = await scans.abandon_stale_drafts()
        if n > 0:
            log.info("marked %d idle draft scan(s) abandoned", n)
    except Exception as exc:
        log.error("abandon job failed: %s", exc)


def start_scheduler(scans: ScanService) -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(
        abandon_drafts,
        CronTrigger(hour=3, minute=0, timezone="UTC"),
        args=[scans],
        id="scan-abandon-drafts",
        replace_existing=True,
        coalesce=True,
        max_instances=1,
    )
    scheduler.start()
    return scheduler
