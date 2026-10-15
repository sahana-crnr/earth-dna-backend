// F3 catalog settings. The read endpoints are plain lookups, so the only knobs
// are which routes the app has not adopted yet (muted → 404) and a hard cap on
// list size. The CATALOG_SOURCE_* block is read ONLY by scripts/catalog-seed.ts;
// the API never opens that connection.
import { registerAs } from '@nestjs/config';
import { parseBool, parsePositiveInt } from './scan.config';

/** Catalog routes that can be switched off until the app uses them. */
export const MUTABLE_CATALOG_ENDPOINTS = [
  'models',
  'colours',
  'categories',
  'options',
] as const;
export type MutableCatalogEndpoint = (typeof MUTABLE_CATALOG_ENDPOINTS)[number];

export interface CatalogSourceDb {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  /** Schema holding the taxonomy and product tables. */
  schema: string;
  ssl: boolean;
}

export interface CatalogConfig {
  mutedEndpoints: MutableCatalogEndpoint[];
  listMax: number;
  /** null when any required CATALOG_SOURCE_DB_* value is missing. */
  source: CatalogSourceDb | null;
}

export default registerAs(
  'catalog',
  (): CatalogConfig => ({
    mutedEndpoints: parseMuted(process.env.CATALOG_MUTED_ENDPOINTS),
    listMax: parsePositiveInt(process.env.CATALOG_LIST_MAX, 500),
    source: parseSource(process.env),
  }),
);

/** Default: nothing muted. `categories` was muted until F5 made it the shoe
 *  type list for the Edit screen (F5-D20). */
export function parseMuted(raw: string | undefined): MutableCatalogEndpoint[] {
  if (raw === undefined) return [];
  const out = new Set<MutableCatalogEndpoint>();
  for (const part of raw.split(',')) {
    const v = part.trim().toLowerCase();
    if ((MUTABLE_CATALOG_ENDPOINTS as readonly string[]).includes(v)) {
      out.add(v as MutableCatalogEndpoint);
    }
  }
  return [...out];
}

export function parseSource(env: NodeJS.ProcessEnv): CatalogSourceDb | null {
  const host = env.CATALOG_SOURCE_DB_HOST?.trim();
  const username = env.CATALOG_SOURCE_DB_USERNAME?.trim();
  const password = env.CATALOG_SOURCE_DB_PASSWORD;
  const database = env.CATALOG_SOURCE_DB_NAME?.trim();
  const schema = env.CATALOG_SOURCE_DB_SCHEMA?.trim();
  if (!host || !username || password === undefined || !database || !schema) {
    return null;
  }
  return {
    host,
    port: parsePositiveInt(env.CATALOG_SOURCE_DB_PORT, 5432),
    username,
    password,
    database,
    schema,
    ssl: parseBool(env.CATALOG_SOURCE_DB_SSL, true),
  };
}
