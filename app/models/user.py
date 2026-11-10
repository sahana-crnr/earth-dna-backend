"""`users` and `refresh_tokens` (src/user/entities, src/auth/entities)."""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects import postgresql as pg
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import NOW, Base, created_at, updated_at, uuid_pk


class User(Base):
    __tablename__ = "users"
    __table_args__ = (
        UniqueConstraint("email", name="UQ_users_email"),
        CheckConstraint("\"role\" IN ('USER','ADMIN')", name="CHK_users_role"),
        Index("UQ_users_email_lower", text("lower((email)::text)"), unique=True),
        Index(
            "UQ_users_provider_user_id",
            "authProvider",
            "providerUserId",
            unique=True,
            postgresql_where=text('"providerUserId" IS NOT NULL'),
        ),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    full_name: Mapped[str] = mapped_column("fullName", String(255), nullable=False)
    email: Mapped[str] = mapped_column(String(255), nullable=False)
    password: Mapped[str | None] = mapped_column(String(255))
    reset_password_token: Mapped[str | None] = mapped_column(
        "resetPasswordToken", String(64)
    )
    reset_password_expiry: Mapped[datetime | None] = mapped_column(
        "resetPasswordExpiry", DateTime(timezone=True)
    )
    country: Mapped[str | None] = mapped_column(String(100))
    zip_code: Mapped[str | None] = mapped_column("zipCode", String(20))
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()
    country_code: Mapped[str | None] = mapped_column("countryCode", String(10))
    auth_provider: Mapped[str] = mapped_column(
        "authProvider", String(20), nullable=False, server_default=text("'local'")
    )
    provider_user_id: Mapped[str | None] = mapped_column("providerUserId", String(255))
    role: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default=text("'USER'")
    )
    password_changed_at: Mapped[datetime | None] = mapped_column(
        "passwordChangedAt", DateTime(timezone=True)
    )


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"
    __table_args__ = (Index("IDX_refresh_tokens_userId", "userId"),)

    id: Mapped[uuid.UUID] = uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        "userId",
        pg.UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE", name="FK_refresh_tokens_user"),
        nullable=False,
    )
    token_hash: Mapped[str] = mapped_column("tokenHash", String(64), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(
        "expiresAt", DateTime(timezone=True), nullable=False
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        "revokedAt", DateTime(timezone=True)
    )
    replaced_by_token_id: Mapped[uuid.UUID | None] = mapped_column(
        "replacedByTokenId", pg.UUID(as_uuid=True)
    )
    user_agent: Mapped[str | None] = mapped_column("userAgent", String(255))
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()


__all__ = ["NOW", "RefreshToken", "User"]
