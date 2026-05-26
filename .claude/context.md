# Earth DNA — Daily Context Snapshot
> Generated: 2026-05-26 11:09:44 IST

---

## Git Status
```
 M package.json
 M src/app.module.ts
?? .claude/
?? CLAUDE.md
?? scripts/
?? src/auth/
?? src/user/
```

## Recent Commits (last 20)
```
a2d3dcb fix: use port 5433 for Docker PostgreSQL to avoid conflict with local Homebrew Postgres
54adf7d feat: initial NestJS + TypeORM + PostgreSQL setup
```

## Active Branch
```
master
```

---

## Source Tree (src/)
```
src/app.controller.spec.ts
src/app.controller.ts
src/app.module.ts
src/app.service.ts
src/auth/auth.controller.spec.ts
src/auth/auth.controller.ts
src/auth/auth.module.ts
src/auth/auth.service.spec.ts
src/auth/auth.service.ts
src/common/filters/http-exception.filter.ts
src/common/interceptors/response.interceptor.ts
src/config/app.config.ts
src/config/database.config.ts
src/config/index.ts
src/database/data-source.ts
src/main.ts
src/user/user.controller.spec.ts
src/user/user.controller.ts
src/user/user.module.ts
src/user/user.service.spec.ts
src/user/user.service.ts
```

---

## Modules
- `src/app.module.ts`
- `src/auth/auth.module.ts`
- `src/user/user.module.ts`

## Entities
_(none yet)_

## DTOs
_(none yet)_

## Migrations
_(none yet)_

---

## Runtime Dependencies
```
  @nestjs/common: ^11.0.1
  @nestjs/config: ^4.0.4
  @nestjs/core: ^11.0.1
  @nestjs/platform-express: ^11.0.1
  @nestjs/typeorm: ^11.0.1
  class-transformer: ^0.5.1
  class-validator: ^0.15.1
  pg: ^8.21.0
  reflect-metadata: ^0.2.2
  rxjs: ^7.8.1
  typeorm: ^1.0.0
```

## Environment Variables (keys only)
```
  API_PREFIX
  DB_HOST
  DB_LOGGING
  DB_NAME
  DB_PASSWORD
  DB_PORT
  DB_SYNC
  DB_USERNAME
  NODE_ENV
  PORT
```

---

## Docker Services
```
NAMES                STATUS                    PORTS
earth_dna_postgres   Up 32 minutes (healthy)   0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp
```

---
_End of snapshot. Run `npm run claude:sync` again to refresh._
