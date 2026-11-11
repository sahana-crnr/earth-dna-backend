"""Deployed environments must run as the task role, never as a static key."""

from __future__ import annotations

from app.core.aws import boto_session
from tests.conftest import make_settings


def _explicit_credentials(session: object) -> object:
    # boto3 stores an explicitly passed key pair on the botocore session;
    # the default chain (task role, profile, env) leaves this unset.
    return getattr(session, "_session")._credentials  # noqa: B009


def test_local_uses_explicit_keys() -> None:
    s = make_settings(
        APP_ENV="local", AWS_ACCESS_KEY_ID="AKIAX", AWS_SECRET_ACCESS_KEY="s"
    )
    creds = _explicit_credentials(boto_session(s))
    assert creds is not None
    assert creds.access_key == "AKIAX"  # type: ignore[attr-defined]


def test_dev_ignores_static_keys() -> None:
    s = make_settings(
        APP_ENV="dev", AWS_ACCESS_KEY_ID="AKIAX", AWS_SECRET_ACCESS_KEY="s"
    )
    session = boto_session(s)
    assert session.region_name == s.AWS_REGION
    assert _explicit_credentials(session) is None


def test_prod_ignores_profile_too() -> None:
    s = make_settings(APP_ENV="prod", AWS_PROFILE="earthdna")
    assert getattr(boto_session(s), "_session").profile is None  # noqa: B009
