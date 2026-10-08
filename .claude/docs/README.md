# Feature guides

One file per backend feature of the S.H.O.E.S. flow: what it does, the rules, every endpoint with its error codes, and the settings. Swagger at `/docs` on each environment is the field-level reference; these files explain the behaviour behind it.

| Feature | File | Routes |
|---|---|---|
| F1 — scan sessions and photo upload | [f1-scan-session.md](f1-scan-session.md) | `/scans` E1–E9 |
| F2 — identification results | [f2-identification-results.md](f2-identification-results.md) | `/scans/{id}/shoes/{id}/result`, `/scans/{id}/results` E10–E11 |
| F3 — match feedback and catalog | [f3-match-feedback.md](f3-match-feedback.md) | `/scans/{id}/shoes/{id}/confirm|reject` E12–E13, `/catalog/*` E14–E19 |

Browser test pages for each feature live in the `local-infra/ui` folder next to this repository (served on `http://localhost:8088` by `docker compose up` there).
