---
description: Scaffold a complete NestJS CRUD feature module (entity + DTOs + service + controller + module)
---

You are scaffolding a new NestJS feature module named: **$ARGUMENTS**

Read `CLAUDE.md` first to apply the project's naming conventions, patterns, and coding standards.

Generate ALL of the following files (no placeholders — fully working code):

1. **`src/$ARGUMENTS/$ARGUMENTS.entity.ts`**
   - UUID primary key (`@PrimaryGeneratedColumn('uuid')`)
   - `createdAt` and `updatedAt` timestamps
   - Sensible domain columns based on the module name (ask if unclear)
   - Explicit snake_case table name
   - `@Exclude()` on sensitive fields

2. **`src/$ARGUMENTS/dto/create-$ARGUMENTS.dto.ts`**
   - class-validator decorators on every field
   - No `id`, `createdAt`, `updatedAt` (those are server-managed)

3. **`src/$ARGUMENTS/dto/update-$ARGUMENTS.dto.ts`**
   - `extends PartialType(Create$ArgumentsDto)` from `@nestjs/mapped-types`

4. **`src/$ARGUMENTS/$ARGUMENTS.service.ts`**
   - Full CRUD: `findAll()`, `findOne(id)`, `create(dto)`, `update(id, dto)`, `remove(id)`
   - Inject `@InjectRepository($ArgumentsEntity)`
   - Throw `NotFoundException` when entity not found

5. **`src/$ARGUMENTS/$ARGUMENTS.controller.ts`**
   - `@Controller('$arguments')` (kebab-case, plural)
   - GET /, GET /:id, POST /, PATCH /:id, DELETE /:id
   - Use `ParseUUIDPipe` on id params
   - `@HttpCode(HttpStatus.CREATED)` on POST
   - `@HttpCode(HttpStatus.NO_CONTENT)` on DELETE

6. **`src/$ARGUMENTS/$ARGUMENTS.module.ts`**
   - `TypeOrmModule.forFeature([$ArgumentsEntity])`
   - Declare controller and service

After generating all files:
- Show the exact `import` line to add to `src/app.module.ts`
- Remind to run `npm run migration:generate -- src/database/migrations/Add$ArgumentsTable`
