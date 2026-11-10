"""bcrypt with the Node library's behaviour (cost 10, `$2b$`, 72-byte truncation).

Hashes written by the Node service verify here and the other way round, so
nobody has to reset a password at the switch.
"""

from __future__ import annotations

import asyncio

import bcrypt

BCRYPT_SALT_ROUNDS = 10
_MAX_BYTES = 72


def _prepare(password: str) -> bytes:
    # kelektiv/node.bcrypt.js silently uses the first 72 bytes; python-bcrypt
    # >= 4.1 raises instead, so truncate to keep the same accept/reject answer.
    return password.encode("utf-8")[:_MAX_BYTES]


def hash_password(password: str) -> str:
    return bcrypt.hashpw(_prepare(password), bcrypt.gensalt(BCRYPT_SALT_ROUNDS)).decode(
        "ascii"
    )


def verify_password(password: str, hashed: str | None) -> bool:
    if not hashed:
        return False
    try:
        return bcrypt.checkpw(_prepare(password), hashed.encode("ascii"))
    except ValueError:
        return False


async def hash_password_async(password: str) -> str:
    return await asyncio.to_thread(hash_password, password)


async def verify_password_async(password: str, hashed: str | None) -> bool:
    return await asyncio.to_thread(verify_password, password, hashed)
