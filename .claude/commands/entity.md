---
description: Generate a single TypeORM entity file for the given name and optional field list
---

Generate a TypeORM entity for: **$ARGUMENTS**

Format of $ARGUMENTS: `EntityName [field:type field:type ...]`
Examples:
  - `Post title:string body:text published:boolean author:relation`
  - `Product name:string price:number stock:number`

Read `CLAUDE.md` for entity conventions before generating.

Rules:
- File: `src/<name>/<name>.entity.ts` (kebab-case filename, PascalCase class)
- Always include: `id` (UUID), `createdAt`, `updatedAt`
- Map field types: string→varchar, text→text, number→decimal/int, boolean→boolean, relation→stub with TODO
- Use explicit column names in snake_case via `{ name: 'column_name' }`
- Add `@Exclude()` to any field named `password`, `hash`, `secret`, `token`
- Explicit table name in snake_case plural (e.g. `@Entity('blog_posts')`)
- Export a `typeorm:import` line to add to `data-source.ts` entities array

After the entity, show:
1. The import line needed in the feature module
2. The migration command to run
