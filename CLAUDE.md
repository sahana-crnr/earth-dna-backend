# Earth DNA — Backend Project Guide

> This file is automatically read by Claude Code at the start of every session.
> Keep it up-to-date when you add new modules, entities, or change conventions.

---

## Project Overview

**earth-dna-BE** is a NestJS REST API backend for the Earth DNA platform.  
Current focus: authentication, user management, and domain modules (TBD).

---

## Tech Stack & Official Documentation

| Technology | Version | Official Docs |
|---|---|---|
| **NestJS** | 11.x | https://docs.nestjs.com |
| **TypeORM** | 1.x | https://typeorm.io |
| **PostgreSQL** | 17 (Docker) | https://www.postgresql.org/docs/17/ |
| **@nestjs/config** | 4.x | https://docs.nestjs.com/techniques/configuration |
| **class-validator** | 0.15 | https://github.com/typestack/class-validator |
| **class-transformer** | 0.5 | https://github.com/typestack/class-transformer |
| **Node.js** | 24.x | https://nodejs.org/docs/latest/api/ |
| **TypeScript** | 5.x | https://www.typescriptlang.org/docs/ |

### Key NestJS Doc Sections
- Modules: https://docs.nestjs.com/modules
- Controllers: https://docs.nestjs.com/controllers
- Providers / Services: https://docs.nestjs.com/providers
- Guards: https://docs.nestjs.com/guards
- Interceptors: https://docs.nestjs.com/interceptors
- Pipes / Validation: https://docs.nestjs.com/techniques/validation
- TypeORM Integration: https://docs.nestjs.com/techniques/database
- Authentication (JWT): https://docs.nestjs.com/security/authentication
- Authorization (RBAC): https://docs.nestjs.com/security/authorization
- Serialization: https://docs.nestjs.com/techniques/serialization
- Custom Decorators: https://docs.nestjs.com/custom-decorators
- Exception Filters: https://docs.nestjs.com/exception-filters
- File Upload: https://docs.nestjs.com/techniques/file-upload
- Config / Env: https://docs.nestjs.com/techniques/configuration

### TypeORM Doc Sections
- Entities: https://typeorm.io/entities
- Relations: https://typeorm.io/relations
- Migrations: https://typeorm.io/migrations
- QueryBuilder: https://typeorm.io/select-query-builder
- Transactions: https://typeorm.io/transactions
- Indices: https://typeorm.io/indices

---

## Environment Setup

```bash
# Install deps
npm install

# Start local PostgreSQL (Docker) — port 5433
npm run db:start

# Start dev server (watch mode)
npm run start:dev

# Daily context sync for Claude
npm run claude:sync
```

> ⚠️ Local Homebrew Postgres runs on 5432 — Docker is mapped to **5433** to avoid conflict.

### .env keys (see .env.example for defaults)
```
NODE_ENV, PORT, API_PREFIX
DB_HOST, DB_PORT=5433, DB_USERNAME, DB_PASSWORD, DB_NAME
DB_SYNC, DB_LOGGING
```

---

## Directory Structure

```
src/
├── config/                  # Typed configs via @nestjs/config registerAs()
│   ├── app.config.ts        # PORT, API_PREFIX, NODE_ENV
│   ├── database.config.ts   # TypeORM connection options
│   └── index.ts             # barrel export
│
├── common/                  # Shared, reusable NestJS primitives
│   ├── filters/
│   │   └── http-exception.filter.ts   # global error → JSON
│   ├── interceptors/
│   │   └── response.interceptor.ts    # wraps all responses
│   ├── decorators/          # custom param / class decorators
│   └── guards/              # global or feature guards
│
├── database/
│   ├── data-source.ts       # TypeORM CLI DataSource (for migrations)
│   └── migrations/          # generated migration files
│
├── auth/                    # Authentication module (JWT)
│   ├── auth.module.ts
│   ├── auth.controller.ts
│   └── auth.service.ts
│
├── user/                    # User module
│   ├── user.module.ts
│   ├── user.controller.ts
│   ├── user.service.ts
│   ├── user.entity.ts       # TypeORM entity (add when ready)
│   └── dto/
│
└── app.module.ts            # Root module — imports all feature modules
```

---

## Coding Conventions

### Naming
| Artifact | Pattern | Example |
|---|---|---|
| Module file | `<name>.module.ts` | `user.module.ts` |
| Controller | `<name>.controller.ts` | `user.controller.ts` |
| Service | `<name>.service.ts` | `user.service.ts` |
| Entity | `<name>.entity.ts` | `user.entity.ts` |
| DTO | `create-<name>.dto.ts` / `update-<name>.dto.ts` | `create-user.dto.ts` |
| Guard | `<name>.guard.ts` | `jwt-auth.guard.ts` |
| Decorator | `<name>.decorator.ts` | `current-user.decorator.ts` |
| Interface | `<name>.interface.ts` | `jwt-payload.interface.ts` |
| Enum | `<name>.enum.ts` | `user-role.enum.ts` |

### Entity Pattern
```typescript
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { Exclude } from 'class-transformer';

@Entity('table_name')          // always explicit snake_case table name
export class SomeEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // ... domain columns

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
```

### DTO Pattern
```typescript
import { IsString, IsEmail, IsOptional, MinLength } from 'class-validator';

export class CreateUserDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;
}

// UpdateDto always extends PartialType
import { PartialType } from '@nestjs/mapped-types';
export class UpdateUserDto extends PartialType(CreateUserDto) {}
```

### Service Pattern
```typescript
@Injectable()
export class UserService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
  ) {}
}
```

### Controller Pattern
```typescript
@Controller('users')          // kebab-case, plural
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get()
  findAll() { ... }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) { ... }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateUserDto) { ... }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto) { ... }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string) { ... }
}
```

### Module Registration
Every new feature module **must** be added to `src/app.module.ts` imports array.  
Entity repositories are registered via `TypeOrmModule.forFeature([Entity])` inside the feature module.

---

## API Response Envelope

All successful responses are wrapped by `ResponseInterceptor`:
```json
{
  "statusCode": 200,
  "message": "Success",
  "data": { ... },
  "timestamp": "2026-05-26T05:00:00.000Z"
}
```

All errors are handled by `AllExceptionsFilter`:
```json
{
  "statusCode": 404,
  "timestamp": "2026-05-26T05:00:00.000Z",
  "path": "/api/v1/users/unknown",
  "message": "User not found"
}
```

---

## Current Modules

| Module | Status | Notes |
|---|---|---|
| `AppModule` | ✅ Core | Root module |
| `AuthModule` | 🚧 Scaffolded | No JWT/entity yet |
| `UserModule` | 🚧 Scaffolded | No entity/DTO yet |

---

## Migration Workflow

```bash
# 1. Create / modify an entity
# 2. Generate a migration
npm run migration:generate -- src/database/migrations/AddUserTable

# 3. Run pending migrations
npm run migration:run

# 4. Roll back last migration
npm run migration:revert
```

> Set `DB_SYNC=false` in staging/production. Only `true` in local dev.

---

## Slash Commands Available

| Command | Description |
|---|---|
| `/sync` | Re-read the daily context snapshot and summarise project state |
| `/feature <name>` | Scaffold a complete CRUD module (entity + DTOs + service + controller) |
| `/entity <name> [fields]` | Generate a TypeORM entity file only |
| `/docs <topic>` | Fetch and summarise official docs for the given topic |

Run `npm run claude:sync` first, then `/sync` in Claude Code to give Claude the latest repo state.
