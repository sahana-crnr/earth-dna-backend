// F7 integration names. The `const` array is the single source for the
// integrations.name CHECK constraint, the seeded rows, the `:name` route
// param and Swagger, so they cannot drift (pattern from scan.types.ts).
export const INTEGRATION_NAMES = ['shoedna', 'valuelens'] as const;
export type IntegrationName = (typeof INTEGRATION_NAMES)[number];

export function isIntegrationName(v: string): v is IntegrationName {
  return (INTEGRATION_NAMES as readonly string[]).includes(v);
}
