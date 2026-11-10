"""One place that builds boto3 sessions.

Deployed environments (dev, stage, prod) always use the default credential
chain, which on ECS is the task role. A static key pair in the secret is
ignored there, so a leftover key can never be the identity the service runs
as. Locally (`APP_ENV=local`) `AWS_PROFILE` wins, then an explicit key pair,
then the default chain.
"""

from __future__ import annotations

from typing import Any

import boto3

from app.core.settings import Settings


def boto_session(settings: Settings) -> boto3.session.Session:
    kwargs: dict[str, Any] = {"region_name": settings.AWS_REGION}
    if settings.APP_ENV == "local":
        if settings.AWS_PROFILE:
            kwargs["profile_name"] = settings.AWS_PROFILE
        elif settings.AWS_ACCESS_KEY_ID and settings.AWS_SECRET_ACCESS_KEY:
            kwargs["aws_access_key_id"] = settings.AWS_ACCESS_KEY_ID
            kwargs["aws_secret_access_key"] = settings.AWS_SECRET_ACCESS_KEY
    return boto3.session.Session(**kwargs)
