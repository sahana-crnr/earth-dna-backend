"""Password-reset mail through SES (src/mail/mail.service.ts).

`MAIL_DRY_RUN=true` logs the link and sends nothing (local). Deployed
environments send from `AWS_SES_FROM_EMAIL` using the task role.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from app.core.aws import boto_session
from app.core.settings import Settings

log = logging.getLogger("app.mail")

SUBJECT = "Reset your Earth DNA password"


def reset_email_html(reset_url: str, expiry_minutes: int) -> str:
    return f"""
<!DOCTYPE html>
<html>
  <body style="font-family: sans-serif; color: #333; max-width: 480px; margin: 0 auto; padding: 24px;">
    <h2>Reset your password</h2>
    <p>Click the button below to reset your Earth DNA password. This link expires in <strong>{expiry_minutes} minutes</strong>.</p>
    <a href="{reset_url}"
       style="display:inline-block;padding:12px 24px;background:#16a34a;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold;">
      Reset Password
    </a>
    <p style="margin-top:24px;font-size:12px;color:#999;">
      If you didn't request this, you can safely ignore this email.
    </p>
  </body>
</html>"""


def reset_email_text(reset_url: str, expiry_minutes: int) -> str:
    return (
        f"Reset your password by visiting: {reset_url}\n\n"
        f"This link expires in {expiry_minutes} minutes."
    )


class MailService:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client: Any | None = None

    def startup_log(self) -> None:
        s = self._settings
        if s.MAIL_DRY_RUN:
            log.warning("MAIL_DRY_RUN is on: reset emails are only logged, never sent")
        elif not s.AWS_SES_FROM_EMAIL:
            log.error("AWS_SES_FROM_EMAIL is not set: every reset email will fail")
        else:
            log.info(
                "Reset emails sent through SES from %s in %s",
                s.AWS_SES_FROM_EMAIL,
                s.AWS_REGION,
            )

    def _ses(self) -> Any:
        if self._client is None:
            self._client = boto_session(self._settings).client(
                "ses",
                config=__import__("botocore.config").config.Config(
                    connect_timeout=5, read_timeout=10, retries={"max_attempts": 2}
                ),
            )
        return self._client

    async def send_password_reset_email(self, to: str, reset_url: str) -> None:
        s = self._settings
        if s.MAIL_DRY_RUN:
            # the link is the credential: only a local developer gets to see it
            shown = reset_url if s.APP_ENV == "local" else "<redacted outside local>"
            log.info("[MAIL DRY RUN] Password reset link for %s: %s", to, shown)
            return
        if not s.AWS_SES_FROM_EMAIL:
            log.error(
                "Password reset email to %s not sent: AWS_SES_FROM_EMAIL is not configured",
                to,
            )
            raise RuntimeError("AWS_SES_FROM_EMAIL is not configured")
        minutes = s.RESET_PASSWORD_TOKEN_EXPIRY_MINUTES
        try:
            result = await asyncio.to_thread(
                self._ses().send_email,
                Source=f"{s.MAIL_FROM_NAME} <{s.AWS_SES_FROM_EMAIL}>",
                Destination={"ToAddresses": [to]},
                Message={
                    "Subject": {"Data": SUBJECT, "Charset": "UTF-8"},
                    "Body": {
                        "Html": {
                            "Charset": "UTF-8",
                            "Data": reset_email_html(reset_url, minutes),
                        },
                        "Text": {
                            "Charset": "UTF-8",
                            "Data": reset_email_text(reset_url, minutes),
                        },
                    },
                },
            )
            log.info(
                "Password reset email sent to %s (SES MessageId %s)",
                to,
                result.get("MessageId"),
            )
        except Exception as exc:
            log.error("SES send failed for password reset email to %s: %r", to, exc)
            raise
