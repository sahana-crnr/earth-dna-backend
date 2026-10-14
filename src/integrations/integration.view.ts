// F7 response shapes. `authRef` is safe to return because it is only a secret's
// name (see IntegrationEntity); `updatedBy` carries id + email so the admin can
// see who changed what without a second lookup.
import type { IntegrationName } from './integration.types';

export interface IntegrationView {
  name: IntegrationName;
  baseUrl: string | null;
  version: string | null;
  authRef: string | null;
  enabled: boolean;
  updatedAt: string;
  updatedBy: { id: string; email: string } | null;
}

export interface IntegrationListView {
  items: IntegrationView[];
}

/** What a consumer (server ShoeDNA in F2, ValueLens in F5) needs to call out. */
export interface ActiveIntegration {
  name: IntegrationName;
  baseUrl: string;
  version: string | null;
  authRef: string | null;
}
