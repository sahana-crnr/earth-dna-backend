# Earth DNA — Backend API

REST API for the Earth DNA app: accounts and sign-in, shoe scan sessions and
photo upload, identification results and review, the catalog, and the user's
shoe collection with public share pages.

**Stack:** Python 3.12 · FastAPI · SQLAlchemy 2 (async) + Alembic · PostgreSQL 16 ·
JWT · AWS (S3, SES, Secrets Manager) · uv · ruff · mypy · pytest + Hypothesis

All routes live under `/api/v1`; interactive OpenAPI docs are served at `/docs`.
Feature guides (behaviour, rules, every endpoint with its error codes) are in
[`.claude/docs/`](.claude/docs/README.md).

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Python | 3.12 | `.python-version` |
| [uv](https://docs.astral.sh/uv/) | ≥ 0.5 | dependency manager, replaces pip/venv |
| Docker | latest | local PostgreSQL (and S3 emulator) |

## Getting started

```bash
git clone <repo-url> earth-dna-B.E && cd earth-dna-B.E
uv sync --all-groups                 # creates .venv with runtime + dev dependencies
cp .env.example .env                 # fill JWT_SECRET (>= 32 chars) and the DB_* values
```

Local PostgreSQL and S3 emulator come from the `local-infra` folder next to
this repository (`docker compose up -d postgres s3`, Postgres on `5433`,
S3 emulator on `4567`). `docker compose up --build` in this folder is an
alternative that runs the backend image itself next to a throwaway Postgres.

```bash
uv run python -m tools.migrate       # creates the schema (or stamps an existing one)
uv run uvicorn app.main:app --port 1234 --reload
```

```
GET http://localhost:1234/api/v1  →  {"statusCode":200,"message":"Success","data":"Welcome to the Earth DNA API!", ...}
Docs: http://localhost:1234/docs
```

### Authenticating in the docs UI

1. `POST /auth/register` or `POST /auth/login` returns `accessToken`.
2. Click **Authorize**, paste the token (without `Bearer `), confirm.
3. Protected routes (for example `GET /auth/profile`) now send the token.

## Configuration — one source

`app/core/settings.py` is the only list of configuration keys; `.env.example`
is generated from it (`uv run python -m tools.gen_env_example`). Precedence:

1. process environment
2. `APP_CONFIG` — one JSON object holding the whole environment's secret
3. `.env`
4. the default declared in `Settings`

`APP_ENV` is `local | dev | stage | prod`. The service refuses to boot when
`JWT_SECRET` is missing, too short, or the placeholder.

Deployed environments never carry per-key variables: the ECS task definition
injects exactly `APP_ENV`, `PORT` and `APP_CONFIG` (the Secrets Manager secret
`earthdna/be/app-env-<region>-<env>`). To add a key: declare it in `Settings`,
regenerate `.env.example`, add the value to the environment's secret.

AWS access in deployed environments comes from the **ECS task role**; static
keys in the secret are ignored outside `APP_ENV=local`. Locally use
`AWS_PROFILE` (or a key pair) in `.env`.

## Response contract

Success:

```json
{ "statusCode": 200, "message": "Success", "data": { ... }, "timestamp": "2026-11-10T10:00:00.000Z" }
```

Error:

```json
{ "statusCode": 400, "timestamp": "...", "path": "/api/v1/...", "message": ["..."], "code": "OPTIONAL_CODE", "details": {} }
```

## Database migrations

Alembic, with `0001_node_schema` as the baseline. `tools.migrate` runs before
the app in the container and does the right thing on any database state:
fresh → create; Alembic history present → upgrade; schema built by the previous
service (its migration ledger complete) → stamp the baseline; schema present
without either ledger → refuse and stop.

```bash
uv run python -m tools.migrate                       # apply
uv run alembic check                                 # models vs database drift (CI gate)
uv run alembic revision --autogenerate -m "add_x"    # new migration after a model change
```

## Catalog seed

Loads brands, categories, models, colours and sizes from the product database
(read only, `CATALOG_SOURCE_DB_*` in `.env`) into this backend's `catalog_*`
tables. Re-runnable; rows missing from the source are deactivated, never
deleted.

```bash
uv run python -m tools.catalog_seed --dry   # read and plan only
uv run python -m tools.catalog_seed         # write
```

## Quality gates

```bash
uv run ruff check . && uv run ruff format --check .
uv run mypy app tools
uv run pytest                      # PY_IT_DB=1 also runs the database tests (needs Postgres)
uv run pre-commit install          # ruff + mypy on every commit
```

`tools/parity/` holds the request suite that proved the service against the
previous implementation (151 cases). Its `--single` mode is the post-deploy
smoke: `uv run python -m tools.parity.run --single --base <url>`.

## CI/CD (GitHub Actions)

| Workflow | Trigger | What it does |
|---|---|---|
| `dev-check.yml` | pull request to `develop` | ruff, mypy, pytest with Postgres, migration + drift check, pip-audit, Docker build |
| `deploy-dev.yml` | push to `develop`, manual | runs the same checks, builds and pushes the image to ECR (`<sha>`, `latest`, `dev-current`), registers a task definition revision (`APP_ENV`, `PORT`, `APP_CONFIG`), rolls the ECS service, waits for stability, health check, smoke run |
| `rollback-dev.yml` | manual | points the service at an earlier task definition revision (empty input = previous) |

AWS access from GitHub uses OIDC (`AWS_ROLE_ARN` in the `dev` environment);
`BACKEND_URL` and `AWS_REGION` are environment variables there.

## Container

`Dockerfile`: `python:3.12-slim`, uv, non-root user, port 1234, `wget` for the
ECS health check (`wget -qO- http://localhost:1234/api/v1`), and
`python -m tools.migrate && uvicorn ...` so a failed migration stops the
container instead of serving a broken schema.

## Project structure

```
app/
  main.py            app factory (prefix, CORS, handlers, routers, lifespan)
  core/              settings, envelope, errors, validation, rate limit, security, db, logging
  api/               routers: health, auth, catalog, scans, results, shoes (+ public /s), integrations
  models/            SQLAlchemy models (column names match the database, camelCase)
  repositories/      query helpers
  schemas/           request validation specs
  services/          business logic, one module per area, *_rules.py for pure rules
  templates/         reset-password form
alembic/             migrations (0001 = baseline schema)
tools/
  migrate.py         stamp-or-upgrade, runs before the app
  catalog_seed.py    catalog import from the product database
  gen_env_example.py writes .env.example from settings.py
  parity/            request suite + smoke runner
tests/               pytest + Hypothesis; tests/db needs PY_IT_DB=1
.claude/docs/        feature guides (F1–F7) and the backend guide
```

## License

Private — All rights reserved.
