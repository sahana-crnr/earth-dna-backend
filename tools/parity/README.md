# Parity harness

Sends every case in `suite.yaml` to the Node service and to the Python service
and diffs status code, content type and JSON body.

```bash
# Historical: Node on :1234 (branch backup/node-develop: npm run build && node dist/main.js), Python on :1235
uv run uvicorn app.main:app --port 1235
uv run python -m tools.parity.run --unit U5          # all units
uv run python -m tools.parity.run --only catalog     # name filter
```

Both services must point at the same local Postgres and S3 emulator
(`local-infra`). Each run registers its own user per target (`${target}`,
`${run}`), so the two services never collide.

Case keys: `method`, `path`, `headers`, `json`, `body`, `multipart`
(`fields` + `files` from `fixtures/`), `expect_status`, `save` (json path →
variable), `ignore` (keys / dotted / indexed / `[]` paths), `ignore_body`,
`skip_until_unit`. Strings are compared with UUIDs masked; timestamps, signed
URLs and the id-hashed placeholder values are ignored globally (see the top of
`suite.yaml` for why).
