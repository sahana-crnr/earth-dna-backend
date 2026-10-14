// F7 pure rules: how a PUT body merges onto a stored integration and when the
// result is acceptable. No Nest / TypeORM imports, same as scan-rules.ts.
//
// PUT is a PARTIAL update on purpose: the admin bumps `version` without
// re-sending the URL. In the body, an absent field keeps the stored value and
// an explicit null clears it.

export interface IntegrationSettings {
  baseUrl: string | null;
  version: string | null;
  authRef: string | null;
  enabled: boolean;
}

export type IntegrationPatch = {
  [K in keyof IntegrationSettings]?: IntegrationSettings[K] | null;
};

const NULLABLE = ['baseUrl', 'version', 'authRef'] as const;

export function applyUpdate(
  current: IntegrationSettings,
  patch: IntegrationPatch,
): IntegrationSettings {
  const next: IntegrationSettings = {
    baseUrl: current.baseUrl,
    version: current.version,
    authRef: current.authRef,
    enabled: current.enabled,
  };
  for (const k of NULLABLE) {
    if (patch[k] !== undefined) next[k] = patch[k] ?? null;
  }
  // `enabled` is not nullable; a null is treated as "not sent".
  if (patch.enabled !== undefined && patch.enabled !== null) {
    next.enabled = patch.enabled;
  }
  return next;
}

/** Why these settings cannot be stored, or null when they can. */
export function incompleteReason(s: IntegrationSettings): string | null {
  if (s.enabled && !s.baseUrl) {
    return 'An integration cannot be enabled without a baseUrl';
  }
  return null;
}

export function settingsEqual(
  a: IntegrationSettings,
  b: IntegrationSettings,
): boolean {
  return (
    a.baseUrl === b.baseUrl &&
    a.version === b.version &&
    a.authRef === b.authRef &&
    a.enabled === b.enabled
  );
}
