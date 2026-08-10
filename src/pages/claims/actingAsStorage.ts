/**
 * e-Claims — per-tenant storage for the "acting as" demo pointer.
 *
 * ClaimsPage's pre-auth demo stub persists the selected employee id so the
 * choice survives reloads. Pre-multi-tenant it lived under ONE global key
 * (`myhrms:claims:actingAs`) — a stale cross-tenant pointer (audit L2): after
 * switching companies it referenced another tenant's employee. It is now
 * namespaced per tenant (`myhrms:t:<companyId>:claims:actingAs`), mirroring
 * the lib/db.ts key convention (same pattern as lib/orgChart.ts extras).
 *
 * The legacy global key was written when only co-asm existed, so on first
 * access it migrates into the DEFAULT company namespace — same target as
 * db.ts migrateLegacyData() — and is then removed. Idempotent: the tenant
 * value wins when both exist; the global key is always removed.
 */
import { DEFAULT_COMPANY_ID, getActiveTenantId } from '@/lib/db';

const TENANT_PREFIX = 'myhrms:t:';
const ACTING_AS_COLLECTION = 'claims:actingAs';
/** Legacy pre-multi-tenant global key (audit L2) — migrated, then removed. */
const LEGACY_ACTING_AS_KEY = 'myhrms:claims:actingAs';

function actingAsKey(tenantId?: string): string {
  return `${TENANT_PREFIX}${tenantId ?? getActiveTenantId() ?? DEFAULT_COMPANY_ID}:${ACTING_AS_COLLECTION}`;
}

/** Idempotent legacy migration — see file header. */
function migrateLegacyActingAs(): void {
  try {
    const legacy = localStorage.getItem(LEGACY_ACTING_AS_KEY);
    if (legacy === null) return;
    const target = actingAsKey(DEFAULT_COMPANY_ID);
    if (localStorage.getItem(target) === null) {
      localStorage.setItem(target, legacy);
    }
    localStorage.removeItem(LEGACY_ACTING_AS_KEY);
  } catch {
    /* storage unavailable — retry on next access */
  }
}

/** Persisted acting-as employee id for the active (or given) tenant, or null. */
export function getActingAsId(tenantId?: string): string | null {
  migrateLegacyActingAs();
  try {
    return localStorage.getItem(actingAsKey(tenantId));
  } catch {
    return null;
  }
}

/** Persist the acting-as employee id under the active (or given) tenant. */
export function setActingAsId(id: string, tenantId?: string): void {
  migrateLegacyActingAs();
  try {
    localStorage.setItem(actingAsKey(tenantId), id);
  } catch {
    /* ignore — demo pointer is non-critical */
  }
}
