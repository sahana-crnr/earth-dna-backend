"""Runtime configuration: the single list of every key the service reads.

Source order (highest wins):
  1. process environment            (ECS task definition `environment`, the shell)
  2. APP_CONFIG                      (one JSON object: the whole per-environment
                                      secret, injected by the task definition)
  3. .env file                       (local development only)
  4. the default declared on the field below

Keys, types and defaults mirror the NestJS `src/config/*.ts` files one for one so
the two services behave the same against the same environment. Lenient parsing
(`parse_bool`, `parse_positive_int`) is kept where Node had it: a bad value
falls back to the default instead of refusing to boot. Secrets are never logged.
"""

from __future__ import annotations

import json
import os
import re
from typing import Annotated, Any, Literal

from pydantic import AliasChoices, Field, field_validator, model_validator
from pydantic.fields import FieldInfo
from pydantic_settings import (
    BaseSettings,
    NoDecode,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
)
from sqlalchemy.engine import URL

# List-typed keys are comma lists in the environment (Node `parseClientIds`),
# not JSON arrays; NoDecode hands the raw string to the validators below.
CsvList = Annotated[list[str], NoDecode]

AppEnv = Literal["local", "dev", "stage", "prod"]
ShoeView = Literal["top", "right", "left", "sole"]
PhotoType = Literal["jpeg", "png"]
CatalogEndpoint = Literal["models", "colours", "categories", "options"]

MIN_JWT_SECRET_LENGTH = 32
PLACEHOLDER_SECRET = "fallback-secret"  # noqa: S105

# Node's NODE_ENV values seen in .env files and the dev2 task definition.
_ENV_ALIASES: dict[str, AppEnv] = {
    "local": "local",
    "development": "local",
    "test": "local",
    "dev": "dev",
    "dev2": "dev",
    "stage": "stage",
    "staging": "stage",
    "prod": "prod",
    "production": "prod",
}


# ─── lenient parsers (same semantics as src/config/scan.config.ts) ──────────
def parse_bool(raw: object, fallback: bool) -> bool:
    if isinstance(raw, bool):
        return raw
    v = str(raw if raw is not None else "").strip().lower()
    if v in ("true", "1", "yes", "on"):
        return True
    if v in ("false", "0", "no", "off"):
        return False
    return fallback


_INT = re.compile(r"^[+-]?[0-9]+")


def _parse_int(raw: object) -> int | None:
    """`Number.parseInt(raw, 10)`: leading ASCII digits only, else NaN (None)."""
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw
    m = _INT.match(str(raw if raw is not None else "").strip())
    return int(m.group(0)) if m else None


def parse_positive_int(raw: object, fallback: int) -> int:
    n = _parse_int(raw)
    return n if n is not None and n > 0 else fallback


def parse_non_negative_int(raw: object, fallback: int) -> int:
    n = _parse_int(raw)
    return n if n is not None and n >= 0 else fallback


def parse_csv(raw: object) -> list[str]:
    """`parseClientIds`: comma list, trimmed, empties dropped."""
    if raw is None:
        return []
    if isinstance(raw, list):
        return [str(x).strip() for x in raw if str(x).strip()]
    return [p.strip() for p in str(raw).split(",") if p.strip()]


def parse_photo_types(raw: object) -> list[PhotoType]:
    out: list[PhotoType] = []
    for part in parse_csv(raw):
        v = part.lower()
        if v in ("jpeg", "jpg") and "jpeg" not in out:
            out.append("jpeg")
        elif v == "png" and "png" not in out:
            out.append("png")
    return out or ["jpeg", "png"]


def _non_empty(raw: object) -> str | None:
    v = str(raw if raw is not None else "").strip()
    return v or None


class AppConfigJsonSource(PydanticBaseSettingsSource):
    """Reads the whole environment secret from the APP_CONFIG variable (JSON)."""

    def __init__(self, settings_cls: type[BaseSettings]) -> None:
        super().__init__(settings_cls)
        raw = os.environ.get("APP_CONFIG")
        self._data: dict[str, Any] = {}
        if raw and raw.strip():
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise RuntimeError(
                    "APP_CONFIG is not valid JSON; fix the environment secret"
                ) from exc
            if not isinstance(parsed, dict):
                raise RuntimeError("APP_CONFIG must be a JSON object")
            self._data = {str(k): v for k, v in parsed.items()}

    def get_field_value(
        self, field: FieldInfo, field_name: str
    ) -> tuple[Any, str, bool]:
        for key in _aliases_for(field, field_name):
            if key in self._data:
                value = self._data[key]
                if isinstance(value, dict):
                    value = json.dumps(value)
                return value, key, False
        return None, field_name, False

    def __call__(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for name, field in self.settings_cls.model_fields.items():
            value, key, _ = self.get_field_value(field, name)
            if value is not None:
                out[key] = value
        return out


def _aliases_for(field: FieldInfo, field_name: str) -> list[str]:
    alias = field.validation_alias
    if isinstance(alias, AliasChoices):
        return [str(c) for c in alias.choices]
    if isinstance(alias, str):
        return [alias]
    return [field_name]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        case_sensitive=True,
        extra="ignore",
        env_file=os.environ.get("ENV_FILE", ".env"),
        env_file_encoding="utf-8",
        populate_by_name=True,
    )

    # ─── Application ─────────────────────────────────────────────────────────
    APP_ENV: str = Field(
        default="local", validation_alias=AliasChoices("APP_ENV", "NODE_ENV")
    )
    PORT: int = 1234
    API_PREFIX: str = "api/v1"
    BACKEND_URL: str = "http://localhost:1234"
    CORS_ORIGINS: CsvList = Field(default_factory=list)
    # Proxies whose X-Forwarded-For / X-Forwarded-Proto are trusted (IPs or CIDRs,
    # e.g. the VPC range the load balancer lives in). Empty = headers ignored and
    # the socket peer is the client, which is what the Node service did.
    TRUSTED_PROXY_IPS: CsvList = Field(default_factory=list)
    LOG_LEVEL: str = "INFO"

    # ─── Database ────────────────────────────────────────────────────────────
    DB_HOST: str = "localhost"
    DB_PORT: int = 5432
    DB_USERNAME: str = "postgres"
    DB_PASSWORD: str = "postgres"
    DB_NAME: str = "earth_dna"
    DB_SSL: bool = False
    DB_LOGGING: bool = False
    # Kept for compatibility with the Node task definition; the Python service
    # never synchronises schema from models (Alembic only).
    DB_SYNC: bool = False

    # ─── JWT / sessions ──────────────────────────────────────────────────────
    JWT_SECRET: str
    JWT_EXPIRES_IN: str = "15m"
    REFRESH_TOKEN_EXPIRES_IN: str = "30d"

    # ─── Admin (F7) ──────────────────────────────────────────────────────────
    ADMIN_EMAIL: str | None = None
    ADMIN_PASSWORD: str | None = None
    ADMIN_DISABLE: bool = False

    # ─── Mail ────────────────────────────────────────────────────────────────
    MAIL_FROM_NAME: str = "Earth DNA"
    MAIL_DRY_RUN: bool = False
    RESET_PASSWORD_TOKEN_EXPIRY_MINUTES: int = 15
    AWS_SES_FROM_EMAIL: str = ""

    # ─── Rate limiting ───────────────────────────────────────────────────────
    THROTTLE_LIMIT: int = 100
    THROTTLE_TTL_MS: int = 60000

    # ─── AWS ─────────────────────────────────────────────────────────────────
    # Credentials come from the boto3 default chain (task role in ECS, AWS_PROFILE
    # locally). The static key pair is accepted only so an old environment still
    # boots; it is not required anywhere.
    AWS_REGION: str = "us-east-1"
    AWS_PROFILE: str | None = None
    AWS_ACCESS_KEY_ID: str | None = None
    AWS_SECRET_ACCESS_KEY: str | None = None

    # ─── Social sign-in ──────────────────────────────────────────────────────
    GOOGLE_CLIENT_IDS: CsvList = Field(default_factory=list)
    FACEBOOK_APP_ID: str = ""
    FACEBOOK_APP_SECRET: str = ""
    APPLE_CLIENT_IDS: CsvList = Field(default_factory=list)

    # ─── Photo storage ───────────────────────────────────────────────────────
    SHOE_PHOTOS_BUCKET: str | None = None
    STORAGE_S3_ENDPOINT: str | None = None
    STORAGE_S3_PUBLIC_ENDPOINT: str | None = None
    STORAGE_S3_FORCE_PATH_STYLE: bool = False
    STORAGE_S3_ACCESS_KEY: str = "test"
    STORAGE_S3_SECRET_KEY: str = "test"

    # ─── Scans (F1-F3) ───────────────────────────────────────────────────────
    SCAN_MAX_SHOES: int = 4
    SCAN_ALBUM_MAX_SHOES: int = 3
    SCAN_ALBUM_MAX_PHOTOS: int = 12
    SCAN_PHOTO_MAX_BYTES: int = 1048576
    SCAN_PHOTO_ALLOWED_TYPES: Annotated[list[PhotoType], NoDecode] = ["jpeg", "png"]
    SCAN_MAX_OPEN_DRAFTS: int = 0
    SCAN_DELETE_OBJECTS_ON_REMOVE: bool = True
    SCAN_DRAFT_ABANDON_DAYS: int = 30
    SCAN_PHOTO_URL_TTL_SECONDS: int = 900
    SCAN_RESULT_MAX_CANDIDATES: int = 3
    SCAN_RESULT_RAW_MAX_BYTES: int = 8192
    SCAN_INFERENCE_TIMEOUT_MS: int = 25000
    SHOE_VALUE_PLACEHOLDER: bool = True
    SHOE_THUMBNAIL_VIEW: ShoeView = "right"

    # ─── Catalog (F3) ────────────────────────────────────────────────────────
    CATALOG_MUTED_ENDPOINTS: Annotated[list[CatalogEndpoint], NoDecode] = Field(
        default_factory=list
    )
    CATALOG_LIST_MAX: int = 500
    # Read only by tools/catalog_seed.py, never by the API.
    CATALOG_SOURCE_DB_HOST: str | None = None
    CATALOG_SOURCE_DB_PORT: int = 5432
    CATALOG_SOURCE_DB_USERNAME: str | None = None
    CATALOG_SOURCE_DB_PASSWORD: str | None = None
    CATALOG_SOURCE_DB_NAME: str | None = None
    CATALOG_SOURCE_DB_SCHEMA: str | None = None
    CATALOG_SOURCE_DB_SSL: bool = True

    # ─── Shoes (F4-F7) ───────────────────────────────────────────────────────
    SHOE_MAX_PHOTOS: int = 8
    SHOE_PHOTO_URL_TTL_SECONDS: int = 900
    SHARE_BASE_URL: str | None = None
    SHARE_TOKEN_RANDOM_CHARS: int = 12
    SHOE_UPLOAD_PREFIX: str = "shoes"

    # ─── source order ────────────────────────────────────────────────────────
    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        # `dotenv_settings` honours `_env_file=` passed at construction (tests
        # pass None so the developer's .env is never read).
        return (
            init_settings,
            env_settings,
            AppConfigJsonSource(settings_cls),
            dotenv_settings,
        )

    # ─── validators (Node parsing rules) ─────────────────────────────────────
    @field_validator("LOG_LEVEL", mode="before")
    @classmethod
    def _log_level(cls, v: object) -> str:
        level = str(v if v is not None else "INFO").strip().upper() or "INFO"
        if level not in ("CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG"):
            raise ValueError(
                f"LOG_LEVEL must be one of CRITICAL, ERROR, WARNING, INFO, DEBUG (got {v!r})"
            )
        return level

    @field_validator("APP_ENV", mode="before")
    @classmethod
    def _env(cls, v: object) -> str:
        key = str(v if v is not None else "local").strip().lower() or "local"
        if key not in _ENV_ALIASES:
            raise ValueError(
                f"APP_ENV must be one of local, dev, stage, prod (got {key!r})"
            )
        return _ENV_ALIASES[key]

    @field_validator(
        "DB_SSL",
        "DB_LOGGING",
        "DB_SYNC",
        "ADMIN_DISABLE",
        "MAIL_DRY_RUN",
        "STORAGE_S3_FORCE_PATH_STYLE",
        "SCAN_DELETE_OBJECTS_ON_REMOVE",
        "SHOE_VALUE_PLACEHOLDER",
        "CATALOG_SOURCE_DB_SSL",
        mode="before",
    )
    @classmethod
    def _bools(cls, v: object, info: Any) -> bool:
        default = cls.model_fields[info.field_name].default
        return parse_bool(v, bool(default))

    @field_validator(
        "PORT",
        "DB_PORT",
        "RESET_PASSWORD_TOKEN_EXPIRY_MINUTES",
        "THROTTLE_LIMIT",
        "THROTTLE_TTL_MS",
        "SCAN_MAX_SHOES",
        "SCAN_ALBUM_MAX_SHOES",
        "SCAN_ALBUM_MAX_PHOTOS",
        "SCAN_PHOTO_MAX_BYTES",
        "SCAN_DRAFT_ABANDON_DAYS",
        "SCAN_PHOTO_URL_TTL_SECONDS",
        "SCAN_RESULT_MAX_CANDIDATES",
        "SCAN_RESULT_RAW_MAX_BYTES",
        "SCAN_INFERENCE_TIMEOUT_MS",
        "CATALOG_LIST_MAX",
        "CATALOG_SOURCE_DB_PORT",
        "SHOE_MAX_PHOTOS",
        "SHOE_PHOTO_URL_TTL_SECONDS",
        "SHARE_TOKEN_RANDOM_CHARS",
        mode="before",
    )
    @classmethod
    def _positive_ints(cls, v: object, info: Any) -> int:
        default = cls.model_fields[info.field_name].default
        return parse_positive_int(v, int(default))

    @field_validator("SCAN_MAX_OPEN_DRAFTS", mode="before")
    @classmethod
    def _non_negative(cls, v: object) -> int:
        return parse_non_negative_int(v, 0)

    @field_validator(
        "CORS_ORIGINS",
        "TRUSTED_PROXY_IPS",
        "GOOGLE_CLIENT_IDS",
        "APPLE_CLIENT_IDS",
        mode="before",
    )
    @classmethod
    def _csv(cls, v: object) -> list[str]:
        return parse_csv(v)

    @field_validator("SCAN_PHOTO_ALLOWED_TYPES", mode="before")
    @classmethod
    def _photo_types(cls, v: object) -> list[PhotoType]:
        return parse_photo_types(v)

    @field_validator("CATALOG_MUTED_ENDPOINTS", mode="before")
    @classmethod
    def _muted(cls, v: object) -> list[CatalogEndpoint]:
        allowed = ("models", "colours", "categories", "options")
        out: list[CatalogEndpoint] = []
        for part in parse_csv(v):
            p = part.lower()
            if p in allowed and p not in out:
                out.append(p)  # type: ignore[arg-type]
        return out

    @field_validator("SHOE_THUMBNAIL_VIEW", mode="before")
    @classmethod
    def _view(cls, v: object) -> str:
        s = str(v if v is not None else "").strip().lower()
        return s if s in ("top", "right", "left", "sole") else "right"

    @field_validator("SHARE_BASE_URL", mode="before")
    @classmethod
    def _share_url(cls, v: object) -> str | None:
        s = _non_empty(v)
        return s.rstrip("/") or None if s else None

    @field_validator("SHOE_UPLOAD_PREFIX", mode="before")
    @classmethod
    def _prefix(cls, v: object) -> str:
        s = str(v if v is not None else "").strip().strip("/")
        return s or "shoes"

    @field_validator(
        "ADMIN_EMAIL",
        "ADMIN_PASSWORD",
        "AWS_PROFILE",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "SHOE_PHOTOS_BUCKET",
        "STORAGE_S3_ENDPOINT",
        "STORAGE_S3_PUBLIC_ENDPOINT",
        "CATALOG_SOURCE_DB_HOST",
        "CATALOG_SOURCE_DB_USERNAME",
        "CATALOG_SOURCE_DB_NAME",
        "CATALOG_SOURCE_DB_SCHEMA",
        mode="before",
    )
    @classmethod
    def _optional_strings(cls, v: object) -> str | None:
        return _non_empty(v)

    @field_validator("FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET", mode="before")
    @classmethod
    def _trimmed(cls, v: object) -> str:
        return str(v if v is not None else "").strip()

    @model_validator(mode="after")
    def _jwt_secret(self) -> Settings:
        # SECURITY-12 / Node validateJwtSecret: refuse to sign with a known key.
        secret = self.JWT_SECRET
        if not secret or secret == PLACEHOLDER_SECRET:
            raise ValueError(
                "JWT_SECRET is missing or still the placeholder value. "
                "Generate one with: python -c "
                '"import secrets; print(secrets.token_hex(32))"'
            )
        if len(secret) < MIN_JWT_SECRET_LENGTH:
            raise ValueError(
                f"JWT_SECRET must be at least {MIN_JWT_SECRET_LENGTH} characters "
                f"(got {len(secret)})"
            )
        return self

    # ─── derived ─────────────────────────────────────────────────────────────
    @property
    def env(self) -> AppEnv:
        return self.APP_ENV  # type: ignore[return-value]

    @property
    def is_local(self) -> bool:
        return self.APP_ENV == "local"

    @property
    def api_prefix(self) -> str:
        return "/" + self.API_PREFIX.strip("/")

    @property
    def database_url(self) -> str:
        raw_db_url = os.environ.get("DATABASE_URL")
        if raw_db_url:
            if raw_db_url.startswith("postgres://"):
                raw_db_url = raw_db_url.replace("postgres://", "postgresql+asyncpg://", 1)
            elif raw_db_url.startswith("postgresql://"):
                raw_db_url = raw_db_url.replace("postgresql://", "postgresql+asyncpg://", 1)
            # asyncpg dialect fails if 'sslmode' query param is passed
            raw_db_url = re.sub(r'[\?&]sslmode=[^&]*', '', raw_db_url)
            if "?" not in raw_db_url and "&" in raw_db_url:
                raw_db_url = raw_db_url.replace("&", "?", 1)
            return raw_db_url
        # URL.create escapes `@ / : #` in the password; string formatting did not.
        return URL.create(
            "postgresql+asyncpg",
            username=self.DB_USERNAME,
            password=self.DB_PASSWORD,
            host=self.DB_HOST,
            port=self.DB_PORT,
            database=self.DB_NAME,
        ).render_as_string(hide_password=False)

    def redacted(self) -> dict[str, object]:
        """Settings as a dict safe to log: every secret-like key is masked."""
        out: dict[str, object] = {}
        for key, value in self.model_dump().items():
            if any(s in key for s in ("SECRET", "PASSWORD", "KEY_ID", "_KEY")):
                out[key] = "***" if value else None
            else:
                out[key] = value
        return out


_settings: Settings | None = None


def get_settings() -> Settings:
    """Process-wide settings, built once. Tests call `reset_settings()`."""
    global _settings
    if _settings is None:
        _settings = Settings()
    return _settings


def reset_settings() -> None:
    global _settings
    _settings = None
