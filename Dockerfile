# Earth DNA backend (FastAPI) image.
#
# Runtime contract: port 1234, container health check
# `wget -qO- http://localhost:1234/api/v1`, migrations run first and a failed
# migration stops the container (`&&`).

# ─── Stage 1: resolve and install dependencies ───────────────────────────────
FROM python:3.12-slim-bookworm AS builder

COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /uvx /bin/

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=0

WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
RUN uv sync --locked --no-dev --no-install-project

COPY app ./app
COPY alembic ./alembic
COPY alembic.ini ./
COPY tools/__init__.py tools/migrate.py ./tools/
RUN uv sync --locked --no-dev

# ─── Stage 2: runtime ────────────────────────────────────────────────────────
FROM python:3.12-slim-bookworm AS production

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/app/.venv/bin:$PATH"

# wget: used by the ECS container health check (same as the Node image)
RUN apt-get update \
    && apt-get install -y --no-install-recommends wget \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system app && useradd --system --gid app --home /app app

WORKDIR /app
COPY --from=builder --chown=app:app /app /app

USER app
EXPOSE 1234

# `exec` makes uvicorn PID 1 so the ECS SIGTERM reaches it (graceful stop).
# Proxy headers are handled inside the app (TRUSTED_PROXY_IPS), not by uvicorn,
# so X-Forwarded-For is trusted only from the load balancer.
CMD ["sh", "-c", "python -m tools.migrate && exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-1234} --no-server-header"]
