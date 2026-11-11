# Python backend (FastAPI) — migration guide

The backend is the Python/FastAPI service under `app/`. It replaced the NestJS
service (final Node commit `2d12f8a`, kept on branch `backup/node-develop` and
tag `node-final-2d12f8a`) with **no change to the HTTP contract**: same routes
under `/api/v1`, same request fields, same JSON envelopes, same status codes and
error strings, same database. The app team changed nothing.

Plan and decisions: `aidlc-docs/inception/plans/python-migration-plan.md` (Divesh's
workspace). Per-unit plans: `aidlc-docs/construction/plans/py-u*-code-generation-plan.md`.

## Status (2026-11-10)

| Unit | Routes | Parity vs Node |
|---|---|---|
| U0 foundation | health, envelopes, validation, auth deps, rate limits, Alembic | identical |
| U1 auth | 12 `/auth/*` | identical |
| U2 catalog | 6 `/catalog/*` | identical |
| U3 scans F1 | 10 `/scans` + E20 + abandon job | identical |
| U4 results / review / analyze / admin | 7 (`/scans/.../result|results|analyze|confirm|reject`, `/admin/integrations`) | identical |
| U5 shoes F4-F7 | 12 `/shoes/*` + public `/s/{token}` | identical |

| U6 CI/CD and dev2 switch | `dev-check.yml`, `deploy-dev.yml`, `rollback-dev.yml`, `Dockerfile`, catalog seed port, Node removed | smoke 42/42 |

All 48 Node routes exist in Python. `tools/parity/suite.yaml` holds 151 request
cases that were diffed against the Node build (151/151 identical at the final
run on 2026-11-10). The Node build is gone from this branch, so the diff mode
now needs a checkout of `backup/node-develop` on :1234; the `--single` smoke
mode (`smoke: true` cases, status checks) is what `deploy-dev.yml` runs against
dev2 after every deploy.

## Layout

```
app/
  main.py            app factory (prefix, CORS, handlers, routers)
  core/
    settings.py      the single list of config keys (see "Configuration")
    envelope.py      {statusCode, message:"Success", data, timestamp}
    errors.py        ApiError + handlers → {statusCode, timestamp, path, message, code?, details?}
    validation.py    class-validator compatible rules (400 + message list)
    ratelimit.py     @nestjs/throttler behaviour + headers
    security.py      JWT guard (get_current_user) and roles (require_roles)
    db.py            async SQLAlchemy engine/session
    logging.py       JSON logs, request id, redaction
    time.py          JS toISOString()
  api/               routers: auth, catalog, scans, results, shoes (+ public share), integrations
  models/            SQLAlchemy models, one per table (column names = Node camelCase)
  repositories/      query helpers (users, catalog, scans, shoes)
  schemas/           request specs (class-validator order) per module
  services/          one module per Node service, plus *_rules.py for the pure rules
alembic/             migrations; 0001 = the schema Node built
tools/
  migrate.py         stamp-or-upgrade, advisory lock 727301, runs before the app
  catalog_seed.py    catalog import from the product DB (--dry), port of the Node seed
  parity/            request suite: diff mode (two services) and --single smoke mode
  gen_env_example.py writes .env.example from settings.py
tests/               pytest + Hypothesis; tests/db needs PY_IT_DB=1
```

## Run locally

```bash
uv sync --all-groups                       # Python 3.12, deps from uv.lock
docker compose -f ../local-infra/docker-compose.yml up -d postgres s3
uv run python -m tools.migrate             # stamps 0001 on a Node-migrated DB, else creates the schema
uv run uvicorn app.main:app --port 1235 --reload
```

`/docs` is the OpenAPI UI. `.env.example` lists every key.

## Configuration (one source)

`app/core/settings.py` is the only list of keys. Precedence: process env >
`APP_CONFIG` (one JSON object = the environment's whole Secrets Manager secret)
> `.env` > default. `APP_ENV` is `local | dev | stage | prod` (`NODE_ENV` values
are accepted as aliases). Missing `JWT_SECRET`, or the placeholder, refuses to
boot. Add a key: declare it in `Settings`, run `uv run python -m
tools.gen_env_example`, put the value in the environment's secret.

## Contract rules every unit follows

- Return plain values from handlers; `EnvelopedJSONResponse` wraps them. Declare
  `status_code` explicitly on POST routes (Nest default was 201).
- Raise `ApiError(status, code, message, details?)`; never return error dicts.
- Request bodies and query strings go through `app.core.validation` specs
  copied from the Node DTO, decorator order preserved. Messages are pinned by
  goldens captured from the Node service.
- Datetimes in responses use `to_js_iso` (`...123Z`).
- Column attributes are snake_case in Python, camelCase in SQL — never rename
  a column.
- Per-route rate limits: `@throttle(limit, ttl_ms)` on the handler, same numbers
  as the Node `@Throttle`.

## Proving a change

1. Rules get unit/property tests in `tests/`; routes get cases in
   `tools/parity/suite.yaml` (mark the cheap, self-cleaning ones `smoke: true`).
2. `uv run ruff check . && uv run ruff format --check . && uv run mypy app tools && uv run pytest`
   (`PY_IT_DB=1` for the database tests). CI runs the same plus `alembic check`,
   pip-audit and the Docker build.
3. Merge to `develop` deploys dev2 and runs the smoke suite against it.

## Behaviour notes learned from the goldens

- class-validator reports a field's messages in reverse decorator order, all of
  them; unknown properties come first; nested errors carry the parent path
  (`candidates.0.confidence must ...`).
- `enableImplicitConversion` turns a number into a string for `string` typed
  properties (`password: 5` is valid) but not for union types (`string | null`).
- Postgres `numeric` must be bound as the shortest decimal text (`to_numeric`)
  or `0.92345` rounds to `0.9234` instead of Node's `0.9235`.
- Placeholder values are picked by an FNV-1a hash of the scan-shoe id; the hash
  is byte-identical to Node (pinned test), so the same id gives the same value.

## Known, accepted deviations

- Malformed JSON body: status 400 and shape are the same, the `message` text is
  Python's parser wording instead of V8's. The app never sends malformed JSON.
- `X-Powered-By: Express` is not sent (SECURITY-09).
- CORS preflight answers 200 (Starlette) where Express answered 204; browsers
  accept both, the mobile app sends no preflight.
- Extra security headers are added (`X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, HSTS over https).
- A valid access token whose user row no longer exists is refused (401). Node
  let it through because it only looked up `passwordChangedAt`. No endpoint
  deletes users today, so nothing observable changes for the app.
- Request bodies are capped (100 KiB JSON like Express body-parser; the album
  ceiling for multipart) and JSON is parsed strictly (NaN/Infinity rejected as
  `JSON.parse` does).

## Container and deploy

`Dockerfile`: `python:3.12-slim`, uv, non-root, `wget` kept for the ECS health
check, port 1234, `CMD python -m tools.migrate && uvicorn ...`.

dev2 task definition contract: `environment` = `APP_ENV=dev`, `PORT=1234`;
`secrets` = `APP_CONFIG` ← the whole `earthdna/be/app-env-ue1-dev2` secret.
`TRUSTED_PROXY_IPS` (the VPC range) tells the app which proxies' X-Forwarded-*
headers to believe; without it the socket peer is the client (as Node).
AWS identity on ECS is the task role `earth-dna-be-task-role-ue1-dev2`
(S3 `earthdna-shoe-photos-ue1-dev2/*`, SES send, ShoeDNA API-key secret read);
`app/core/aws.py` ignores static keys outside `APP_ENV=local`. Rollback:
`rollback-dev.yml` with a revision number (41 = last Node revision).
