# Earth DNA — Backend · Claude Project Guide

> **Auto-loaded every session.** Keep the "Current Modules" table and conventions up-to-date
> as the project grows. Run `npm run claude:sync` daily then `/sync` to get a fresh repo snapshot.

---

## Project Overview

**earth-dna-BE** is a NestJS REST API backend for the Earth DNA platform.  
Stack: NestJS 11 · TypeORM 1 · PostgreSQL 17 (Docker on port 5433) · TypeScript 5.

---

## 📚 Official Documentation — Complete Reference

> Every URL below is verified from the live `nestjs/docs.nestjs.com` source.

### NestJS — Core Concepts
| Topic | URL |
|---|---|
| Introduction | https://docs.nestjs.com/ |
| First Steps | https://docs.nestjs.com/first-steps |
| **Controllers** | https://docs.nestjs.com/controllers |
| **Providers / Services** | https://docs.nestjs.com/providers |
| **Modules** | https://docs.nestjs.com/modules |
| Middleware | https://docs.nestjs.com/middlewares |
| **Exception Filters** | https://docs.nestjs.com/exception-filters |
| **Pipes & Validation** | https://docs.nestjs.com/pipes |
| **Guards** | https://docs.nestjs.com/guards |
| **Interceptors** | https://docs.nestjs.com/interceptors |
| **Custom Decorators** | https://docs.nestjs.com/custom-decorators |

### NestJS — Techniques
| Topic | URL |
|---|---|
| **Configuration (@nestjs/config)** | https://docs.nestjs.com/techniques/configuration |
| **Database (TypeORM)** | https://docs.nestjs.com/techniques/database |
| **Validation (class-validator)** | https://docs.nestjs.com/techniques/validation |
| **Serialization (class-transformer)** | https://docs.nestjs.com/techniques/serialization |
| File Upload | https://docs.nestjs.com/techniques/file-upload |
| Caching | https://docs.nestjs.com/techniques/caching |
| Task Scheduling | https://docs.nestjs.com/techniques/task-scheduling |
| Queues (Bull) | https://docs.nestjs.com/techniques/queues |
| Logger | https://docs.nestjs.com/techniques/logger |
| Compression | https://docs.nestjs.com/techniques/compression |
| HTTP Module (Axios) | https://docs.nestjs.com/techniques/http-module |
| Server-Sent Events | https://docs.nestjs.com/techniques/server-sent-events |
| Cookies | https://docs.nestjs.com/techniques/cookies |
| Sessions | https://docs.nestjs.com/techniques/sessions |
| MVC | https://docs.nestjs.com/techniques/mvc |
| Performance (Fastify) | https://docs.nestjs.com/techniques/performance |
| Versioning | https://docs.nestjs.com/techniques/versioning |
| Streaming Files | https://docs.nestjs.com/techniques/streaming-files |
| Events | https://docs.nestjs.com/techniques/events |
| MongoDB | https://docs.nestjs.com/techniques/mongodb |
| SQL (Sequelize) | https://docs.nestjs.com/techniques/sql |

### NestJS — Security
| Topic | URL |
|---|---|
| **Authentication (JWT)** | https://docs.nestjs.com/security/authentication |
| **Authorization (RBAC / CASL)** | https://docs.nestjs.com/security/authorization |
| **CORS** | https://docs.nestjs.com/security/cors |
| **Rate Limiting** | https://docs.nestjs.com/security/rate-limiting |
| Helmet | https://docs.nestjs.com/security/helmet |
| CSRF Protection | https://docs.nestjs.com/security/csrf |
| Encryption & Hashing | https://docs.nestjs.com/security/encryption-hashing |

### NestJS — Fundamentals
| Topic | URL |
|---|---|
| Dependency Injection | https://docs.nestjs.com/fundamentals/dependency-injection |
| Lifecycle Events | https://docs.nestjs.com/fundamentals/lifecycle-events |
| Dynamic Modules | https://docs.nestjs.com/fundamentals/dynamic-modules |
| Async Components | https://docs.nestjs.com/fundamentals/async-components |
| Circular Dependency | https://docs.nestjs.com/fundamentals/circular-dependency |
| Provider Scopes | https://docs.nestjs.com/fundamentals/provider-scopes |
| Lazy Loading | https://docs.nestjs.com/fundamentals/lazy-loading-modules |
| Execution Context | https://docs.nestjs.com/fundamentals/execution-context |
| Lifecycle Events | https://docs.nestjs.com/fundamentals/lifecycle-events |
| Module Reference | https://docs.nestjs.com/fundamentals/module-reference |
| Testing | https://docs.nestjs.com/fundamentals/unit-testing |

### NestJS — OpenAPI / Swagger
| Topic | URL |
|---|---|
| Introduction | https://docs.nestjs.com/openapi/introduction |
| Types & Parameters | https://docs.nestjs.com/openapi/types-and-parameters |
| Operations | https://docs.nestjs.com/openapi/operations |
| Security | https://docs.nestjs.com/openapi/security |
| Mapped Types | https://docs.nestjs.com/openapi/mapped-types |
| Decorators | https://docs.nestjs.com/openapi/decorators |
| CLI Plugin | https://docs.nestjs.com/openapi/cli-plugin |
| Other Features | https://docs.nestjs.com/openapi/other-features |

### NestJS — Recipes (Integrations)
| Topic | URL |
|---|---|
| **TypeORM (Recipe)** | https://docs.nestjs.com/recipes/sql-typeorm |
| **Passport.js** | https://docs.nestjs.com/recipes/passport |
| Prisma | https://docs.nestjs.com/recipes/prisma |
| CQRS | https://docs.nestjs.com/recipes/cqrs |
| Hot Reload | https://docs.nestjs.com/recipes/hot-reload |
| Serve Static | https://docs.nestjs.com/recipes/serve-static |
| Health Checks (Terminus) | https://docs.nestjs.com/recipes/terminus |
| REPL | https://docs.nestjs.com/recipes/repl |
| SWC (Fast Compiler) | https://docs.nestjs.com/recipes/swc |
| Router Module | https://docs.nestjs.com/recipes/router-module |
| Async Local Storage | https://docs.nestjs.com/recipes/async-local-storage |
| CRUD Generator | https://docs.nestjs.com/recipes/crud-generator |
| MongoDB (Mongoose) | https://docs.nestjs.com/recipes/mongodb |

### NestJS — CLI
| Topic | URL |
|---|---|
| Overview | https://docs.nestjs.com/cli/overview |
| Usages | https://docs.nestjs.com/cli/usages |
| Workspaces | https://docs.nestjs.com/cli/workspaces |
| Libraries | https://docs.nestjs.com/cli/libraries |
| Scripts | https://docs.nestjs.com/cli/scripts |

### TypeORM
| Topic | URL |
|---|---|
| Entities | https://typeorm.io/entities |
| Relations | https://typeorm.io/relations |
| Migrations | https://typeorm.io/migrations |
| QueryBuilder | https://typeorm.io/select-query-builder |
| Transactions | https://typeorm.io/transactions |
| Indices | https://typeorm.io/indices |
| Repository API | https://typeorm.io/working-with-repository |
| DataSource | https://typeorm.io/data-source |
| Entity Manager | https://typeorm.io/entity-manager-api |

### Supporting Libraries
| Library | URL |
|---|---|
| class-validator | https://github.com/typestack/class-validator |
| class-transformer | https://github.com/typestack/class-transformer |
| @nestjs/jwt | https://github.com/nestjs/jwt |
| @nestjs/swagger | https://github.com/nestjs/swagger |
| bcrypt | https://github.com/kelektiv/node.bcrypt.js |
| PostgreSQL 17 | https://www.postgresql.org/docs/17/ |

---

## Environment & Setup

```bash
npm install                  # install dependencies
npm run db:start             # start PostgreSQL 17 on Docker (port 5433)
npm run start:dev            # start NestJS in watch mode
npm run claude:sync          # regenerate .claude/context.md daily snapshot
```

### .env keys (copy from .env.example)
```
NODE_ENV=development
PORT=3000
API_PREFIX=api/v1
DB_HOST=localhost
DB_PORT=5433           # 5433 — local Homebrew Postgres occupies 5432
DB_USERNAME=postgres
DB_PASSWORD=postgres
DB_NAME=earth_dna
DB_SYNC=true           # false in staging/production
DB_LOGGING=true
```

---

## Directory Structure

```
src/
├── config/
│   ├── app.config.ts          # registerAs('app', ...) — PORT, API_PREFIX, NODE_ENV
│   ├── database.config.ts     # registerAs('database', ...) — TypeORM options
│   └── index.ts               # barrel export
│
├── common/
│   ├── filters/
│   │   └── http-exception.filter.ts    # @Catch() — structured error JSON
│   ├── interceptors/
│   │   └── response.interceptor.ts     # wraps all responses in envelope
│   ├── guards/                         # e.g. jwt-auth.guard.ts
│   └── decorators/                     # e.g. current-user.decorator.ts
│
├── database/
│   ├── data-source.ts                  # TypeORM CLI DataSource (migrations)
│   └── migrations/                     # generated .ts migration files
│
├── auth/                    # JWT authentication module
├── user/                    # User domain module
└── app.module.ts            # Root — imports all feature modules
```

---

## Naming Conventions

| Artifact | File pattern | Class name |
|---|---|---|
| Module | `foo.module.ts` | `FooModule` |
| Controller | `foo.controller.ts` | `FooController` |
| Service | `foo.service.ts` | `FooService` |
| Entity | `foo.entity.ts` | `FooEntity` |
| Create DTO | `dto/create-foo.dto.ts` | `CreateFooDto` |
| Update DTO | `dto/update-foo.dto.ts` | `UpdateFooDto` |
| Guard | `foo.guard.ts` | `FooGuard` |
| Middleware | `foo.middleware.ts` | `FooMiddleware` |
| Decorator | `foo.decorator.ts` | `@Foo()` |
| Interface | `foo.interface.ts` | `IFoo` |
| Enum | `foo.enum.ts` | `FooEnum` / `FooRole` |

---

## Code Patterns (copy-paste ready)

### Entity
```typescript
import {
  Entity, PrimaryGeneratedColumn, Column,
  CreateDateColumn, UpdateDateColumn,
} from 'typeorm';
import { Exclude } from 'class-transformer';

@Entity('table_name')                      // explicit snake_case plural table
export class FooEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Exclude()                               // never sent in responses
  @Column({ select: false })
  password: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
```

### DTOs
```typescript
// create-foo.dto.ts
import { IsString, IsEmail, MinLength, IsOptional } from 'class-validator';

export class CreateFooDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsString()
  @IsOptional()
  name?: string;
}

// update-foo.dto.ts — always PartialType, never repeat fields
import { PartialType } from '@nestjs/mapped-types';
import { CreateFooDto } from './create-foo.dto';
export class UpdateFooDto extends PartialType(CreateFooDto) {}
```

### Service
```typescript
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

@Injectable()
export class FooService {
  constructor(
    @InjectRepository(FooEntity)
    private readonly fooRepo: Repository<FooEntity>,
  ) {}

  findAll(): Promise<FooEntity[]> {
    return this.fooRepo.find();
  }

  async findOne(id: string): Promise<FooEntity> {
    const entity = await this.fooRepo.findOne({ where: { id } });
    if (!entity) throw new NotFoundException(`Foo #${id} not found`);
    return entity;
  }

  create(dto: CreateFooDto): Promise<FooEntity> {
    const entity = this.fooRepo.create(dto);
    return this.fooRepo.save(entity);
  }

  async update(id: string, dto: UpdateFooDto): Promise<FooEntity> {
    const entity = await this.findOne(id);
    Object.assign(entity, dto);
    return this.fooRepo.save(entity);
  }

  async remove(id: string): Promise<void> {
    const entity = await this.findOne(id);
    await this.fooRepo.remove(entity);
  }
}
```

### Controller
```typescript
import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, ParseUUIDPipe, HttpCode, HttpStatus,
} from '@nestjs/common';

@Controller('foos')                        // kebab-case, plural
export class FooController {
  constructor(private readonly fooService: FooService) {}

  @Get()
  findAll() { return this.fooService.findAll(); }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.fooService.findOne(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateFooDto) { return this.fooService.create(dto); }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFooDto,
  ) { return this.fooService.update(id, dto); }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.fooService.remove(id);
  }
}
```

### Module (feature)
```typescript
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

@Module({
  imports: [TypeOrmModule.forFeature([FooEntity])],
  controllers: [FooController],
  providers: [FooService],
  exports: [FooService],               // export if other modules need it
})
export class FooModule {}
```

### Custom Param Decorator
```typescript
// current-user.decorator.ts
import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const CurrentUser = createParamDecorator(
  (data: string | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest();
    return data ? req.user?.[data] : req.user;
  },
);
// Usage: @CurrentUser() user: UserEntity
//        @CurrentUser('id') userId: string
```

### Composed Decorator (applyDecorators)
```typescript
export function Auth(...roles: Role[]) {
  return applyDecorators(
    SetMetadata('roles', roles),
    UseGuards(JwtAuthGuard, RolesGuard),
    ApiBearerAuth(),
    ApiUnauthorizedResponse({ description: 'Unauthorized' }),
  );
}
// Usage: @Auth(Role.Admin)
```

### JWT Auth Guard
```typescript
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private jwtService: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = this.extractTokenFromHeader(request);
    if (!token) throw new UnauthorizedException();
    try {
      request.user = await this.jwtService.verifyAsync(token, {
        secret: process.env.JWT_SECRET,
      });
    } catch {
      throw new UnauthorizedException();
    }
    return true;
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers['authorization']?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
```

### Swagger Setup (main.ts)
```typescript
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

const swaggerConfig = new DocumentBuilder()
  .setTitle('Earth DNA API')
  .setDescription('Earth DNA backend REST API')
  .setVersion('1.0')
  .addBearerAuth()
  .build();
const document = SwaggerModule.createDocument(app, swaggerConfig);
SwaggerModule.setup('docs', app, document);
// → http://localhost:3000/docs
```

---

## Global Behaviours (already wired in main.ts)

| What | How | Docs |
|---|---|---|
| Request validation | `ValidationPipe({ whitelist, forbidNonWhitelisted, transform })` | https://docs.nestjs.com/techniques/validation |
| Entity serialization | `ClassSerializerInterceptor` + `@Exclude()` / `@Expose()` | https://docs.nestjs.com/techniques/serialization |
| Response envelope | `ResponseInterceptor` → `{ statusCode, message, data, timestamp }` | custom |
| Error handling | `AllExceptionsFilter` → `{ statusCode, timestamp, path, message }` | https://docs.nestjs.com/exception-filters |
| Global prefix | `app.setGlobalPrefix('api/v1')` | https://docs.nestjs.com/faq/global-prefix |

### Built-in Exceptions (throw these from services)
```
NotFoundException · BadRequestException · UnauthorizedException
ForbiddenException · ConflictException · UnprocessableEntityException
InternalServerErrorException · ServiceUnavailableException
```

---

## Key Facts from Docs

### ValidationPipe options used in this project
- `whitelist: true` — strips properties not in the DTO
- `forbidNonWhitelisted: true` — throws if unknown props are sent
- `transform: true` — converts plain payloads to DTO class instances
- `transformOptions.enableImplicitConversion: true` — auto-converts `string` → `number` etc.

### ConfigModule (@nestjs/config) — how to inject typed config
```typescript
// Preferred: inject namespace directly (type-safe)
constructor(
  @Inject(databaseConfig.KEY)
  private dbConfig: ConfigType<typeof databaseConfig>,
) {}

// Or via ConfigService
constructor(private config: ConfigService) {
  const host = this.config.get<string>('database.host');
}
```

### TypeORM — critical warnings
- `synchronize: true` **must never** be used in production (set `DB_SYNC=false`)
- Run `npm run migration:run` before deploying — never rely on auto-sync
- `autoLoadEntities: true` removes the need to list entities in `forRoot`

### Lifecycle Hooks (in order)
1. `onModuleInit()` — after module deps resolved
2. `onApplicationBootstrap()` — after all modules init, before listening
3. `onModuleDestroy()` — after SIGTERM received
4. `beforeApplicationShutdown()` — after all `onModuleDestroy` complete
5. `onApplicationShutdown()` — after connections close

### Provider Types (DI)
- `useClass` — swap implementation per environment
- `useValue` — inject constants, mock objects
- `useFactory` — async factory with injected deps
- `useExisting` — alias an existing provider

---

## Migration Workflow

```bash
# 1. Create or modify an entity file
# 2. Generate migration (auto-diffs DB schema vs entities)
npm run migration:generate -- src/database/migrations/AddUserTable

# 3. Apply migrations
npm run migration:run

# 4. Roll back last migration
npm run migration:revert

# 5. View pending migrations
npm run migration:show
```

---

## Current Modules

| Module | File | Status | Missing |
|---|---|---|---|
| AppModule | `src/app.module.ts` | ✅ core | — |
| AuthModule | `src/auth/auth.module.ts` | 🚧 scaffolded | JWT, entity, DTOs |
| UserModule | `src/user/user.module.ts` | 🚧 scaffolded | entity, DTOs, repository |

---

## Slash Commands

| Command | What it does |
|---|---|
| `/sync` | Reads `.claude/context.md` snapshot → project status + suggested next steps |
| `/feature <name>` | Scaffolds a full CRUD module (entity + DTOs + service + controller + module) |
| `/entity <Name> [field:type …]` | Generates a single TypeORM entity with typed columns |
| `/docs <topic>` | Fetches & summarises official docs, applies pattern to this project |

**Daily workflow:**
```bash
npm run claude:sync   # morning — refresh context snapshot
# then in Claude Code:
/sync                 # see status + get suggestions
/feature product      # build something new
/docs "rate limiting" # look up a doc with code examples
```
