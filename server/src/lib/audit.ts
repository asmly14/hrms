/** Audit-log insert helper — append-only, per tenant. */
import { pool, type Queryable } from '../db/pool';
import { uid } from '../calc/utils';

export interface AuditEntry {
  /** NULL = system/global entry (e.g. national-holiday admin). */
  companyId: string | null;
  actorId?: string;
  actorName: string;
  action: string;
  entity: string;
  entityId?: string;
  detail?: string;
  at?: string;
}

export async function insertAudit(entry: AuditEntry, db: Queryable = pool): Promise<void> {
  const id = uid();
  const doc = {
    id,
    at: entry.at ?? new Date().toISOString(),
    actorId: entry.actorId,
    actorName: entry.actorName,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId,
    detail: entry.detail,
  };
  await db.query(
    `INSERT INTO audit (company_id, id, at, actor_id, actor_name, action, entity, entity_id, detail, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      entry.companyId,
      id,
      doc.at,
      entry.actorId ?? null,
      entry.actorName,
      entry.action,
      entry.entity,
      entry.entityId ?? null,
      entry.detail ?? null,
      JSON.stringify(doc),
    ],
  );
}
