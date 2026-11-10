"""P2 (source precedence) and P3 (refuse to boot) for the single config source."""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st
from pydantic import ValidationError

from app.core.settings import (
    PLACEHOLDER_SECRET,
    Settings,
    parse_bool,
    parse_positive_int,
)
from tests.conftest import TEST_SECRET

KEYS = ["API_PREFIX", "DB_HOST", "MAIL_FROM_NAME", "SHOE_UPLOAD_PREFIX", "DB_NAME"]
value = st.text(
    alphabet=st.characters(whitelist_categories=("L", "N")), min_size=1, max_size=12
)


@pytest.fixture
def clean_env(monkeypatch: pytest.MonkeyPatch) -> Iterator[pytest.MonkeyPatch]:
    for key in Settings.model_fields:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.delenv("NODE_ENV", raising=False)
    monkeypatch.delenv("APP_CONFIG", raising=False)
    yield monkeypatch


@settings(max_examples=100, deadline=None)
@given(
    key=st.sampled_from(KEYS),
    env_v=value,
    cfg_v=value,
    dotenv_v=value,
    use_env=st.booleans(),
    use_cfg=st.booleans(),
    use_dotenv=st.booleans(),
)
def test_precedence_env_over_appconfig_over_dotenv(
    tmp_path_factory: pytest.TempPathFactory,
    key: str,
    env_v: str,
    cfg_v: str,
    dotenv_v: str,
    use_env: bool,
    use_cfg: bool,
    use_dotenv: bool,
) -> None:
    mp = pytest.MonkeyPatch()
    try:
        for k in Settings.model_fields:
            mp.delenv(k, raising=False)
        mp.delenv("APP_CONFIG", raising=False)
        env_file: Path | None = None
        if use_dotenv:
            env_file = tmp_path_factory.mktemp("env") / ".env"
            env_file.write_text(f"{key}={dotenv_v}\nJWT_SECRET={TEST_SECRET}\n")
        else:
            mp.setenv("JWT_SECRET", TEST_SECRET)
        if use_cfg:
            mp.setenv("APP_CONFIG", json.dumps({key: cfg_v}))
        if use_env:
            mp.setenv(key, env_v)
        s = Settings(_env_file=str(env_file) if env_file else None)  # type: ignore[call-arg]
        expected = (
            env_v
            if use_env
            else cfg_v
            if use_cfg
            else dotenv_v
            if use_dotenv
            else Settings.model_fields[key].default
        )
        assert getattr(s, key) == expected
    finally:
        mp.undo()


@pytest.mark.parametrize("bad", ["", PLACEHOLDER_SECRET, "short", "x" * 31])
def test_refuses_bad_jwt_secret(clean_env: pytest.MonkeyPatch, bad: str) -> None:
    with pytest.raises(ValidationError):
        Settings(_env_file=None, JWT_SECRET=bad)  # type: ignore[call-arg]


def test_refuses_missing_jwt_secret(clean_env: pytest.MonkeyPatch) -> None:
    with pytest.raises(ValidationError):
        Settings(_env_file=None)  # type: ignore[call-arg]


@pytest.mark.parametrize("raw", ["not json", "[1,2]", '"str"'])
def test_refuses_bad_app_config(clean_env: pytest.MonkeyPatch, raw: str) -> None:
    clean_env.setenv("APP_CONFIG", raw)
    clean_env.setenv("JWT_SECRET", TEST_SECRET)
    with pytest.raises(RuntimeError):
        Settings(_env_file=None)  # type: ignore[call-arg]


def test_app_config_secret_shape_from_dev2(clean_env: pytest.MonkeyPatch) -> None:
    """The dev2 secret's keys, as a single JSON object, are enough to boot."""
    secret = {
        "APPLE_CLIENT_IDS": "com.a.app,com.b.app",
        "AWS_SES_FROM_EMAIL": "noreply@example.test",
        "BACKEND_URL": "https://api.example.test",
        "DB_HOST": "db.example.test",
        "DB_NAME": "earthdna",
        "DB_PASSWORD": "pw",
        "DB_PORT": "5432",
        "DB_USERNAME": "admin",
        "FACEBOOK_APP_ID": " 123 ",
        "FACEBOOK_APP_SECRET": "fb",
        "GOOGLE_CLIENT_IDS": "a.apps,b.apps, ",
        "JWT_SECRET": TEST_SECRET,
        "SHOE_PHOTOS_BUCKET": "bucket",
    }
    clean_env.setenv("APP_CONFIG", json.dumps(secret))
    clean_env.setenv("APP_ENV", "dev2")
    s = Settings(_env_file=None)  # type: ignore[call-arg]
    assert s.env == "dev"
    assert s.DB_PORT == 5432
    assert s.APPLE_CLIENT_IDS == ["com.a.app", "com.b.app"]
    assert s.GOOGLE_CLIENT_IDS == ["a.apps", "b.apps"]
    assert s.FACEBOOK_APP_ID == "123"
    assert (
        s.database_url == "postgresql+asyncpg://admin:pw@db.example.test:5432/earthdna"
    )
    assert s.redacted()["JWT_SECRET"] == "***"
    assert s.redacted()["DB_PASSWORD"] == "***"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("production", "prod"),
        ("development", "local"),
        ("staging", "stage"),
        ("Dev", "dev"),
    ],
)
def test_node_env_alias(clean_env: pytest.MonkeyPatch, raw: str, expected: str) -> None:
    clean_env.setenv("NODE_ENV", raw)
    clean_env.setenv("JWT_SECRET", TEST_SECRET)
    assert Settings(_env_file=None).env == expected  # type: ignore[call-arg]


def test_unknown_env_refused(clean_env: pytest.MonkeyPatch) -> None:
    clean_env.setenv("APP_ENV", "qa")
    clean_env.setenv("JWT_SECRET", TEST_SECRET)
    with pytest.raises(ValidationError):
        Settings(_env_file=None)  # type: ignore[call-arg]


@given(st.text(max_size=8), st.booleans())
def test_parse_bool_matches_node(raw: str, fallback: bool) -> None:
    v = raw.strip().lower()
    expected = (
        True
        if v in ("true", "1", "yes", "on")
        else False
        if v in ("false", "0", "no", "off")
        else fallback
    )
    assert parse_bool(raw, fallback) == expected


@given(st.text(max_size=8), st.integers(min_value=1, max_value=10_000))
def test_parse_positive_int_falls_back(raw: str, fallback: int) -> None:
    import re

    out = parse_positive_int(raw, fallback)
    assert out > 0
    m = re.match(r"^[+-]?[0-9]+", raw.strip())  # Number.parseInt semantics
    if m and int(m.group(0)) > 0:
        assert out == int(m.group(0))
    else:
        assert out == fallback


def test_lenient_ints_and_lists(clean_env: pytest.MonkeyPatch) -> None:
    clean_env.setenv("JWT_SECRET", TEST_SECRET)
    clean_env.setenv("SCAN_MAX_SHOES", "abc")
    clean_env.setenv("SCAN_MAX_OPEN_DRAFTS", "-3")
    clean_env.setenv("SCAN_PHOTO_ALLOWED_TYPES", "JPG, gif ,png")
    clean_env.setenv("CATALOG_MUTED_ENDPOINTS", "Models, nope, colours")
    clean_env.setenv("SHOE_THUMBNAIL_VIEW", "SOLE")
    clean_env.setenv("SHARE_BASE_URL", "https://earthdna.app///")
    clean_env.setenv("CORS_ORIGINS", "http://a.test, http://b.test")
    s = Settings(_env_file=None)  # type: ignore[call-arg]
    assert s.SCAN_MAX_SHOES == 4
    assert s.SCAN_MAX_OPEN_DRAFTS == 0
    assert s.SCAN_PHOTO_ALLOWED_TYPES == ["jpeg", "png"]
    assert s.CATALOG_MUTED_ENDPOINTS == ["models", "colours"]
    assert s.SHOE_THUMBNAIL_VIEW == "sole"
    assert s.SHARE_BASE_URL == "https://earthdna.app"
    assert s.CORS_ORIGINS == ["http://a.test", "http://b.test"]
