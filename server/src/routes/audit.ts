/**
 * /api/audit — per-tenant audit trail.
 *   GET  /api/audit?companyId=&limit=   Admin/HR (+SuperAdmin with explicit scope).
 *   POST /api/audit                      any authenticated user appends an entry
 *                                        (actor forced to the token identity).
 */
import type { FastifyInstance } from 'fastify';
import { HttpError, resolveCompanyScope } from '../db/collections';
import { query } from '../db/pool';
import { insertAudit } from '../lib/audit';

interface AuditRow {
  id: string;
  at: string;
  actor_id: string | null;
  actor_name: string;
  action: string;
  entity: string;
  entity_id: string | null;
  detail: string | null;
}

function toLog(r: AuditRow): Record<string, unknown> {
  return {
    id: r.id,
    at: r.at,
    actorId: r.actor_id ?? undefined,
    actorName: r.actor_name,
    action: r.action,
    entity: r.entity,
    entityId: r.entity_id ?? undefined,
    detail: r.detail ?? undefined,
  };
}

export default async function auditRoutes(app: FastifyInstance): Promise<void> {
  const pre = { preHandler: [app.authenticate] };

  app.get('/api/audit', pre, async (req, reply) => {
    const user = req.hrmsUser;
    if (user.role !== 'Admin' && user.role !== 'HR' && user.role !== 'SuperAdmin') {
      return reply.code(403).send({ error: 'Only Admin/HR can read the audit log.' });
    }
    const q = (req.query ?? {}) as { companyId?: string; limit?: string };
    const h = req.headers['x-company-id'];
    const companyId = resolveCompanyScope(user, q.companyId ?? (typeof h === 'string' && h ? h : undefined));
    if (!companyId) throw new HttpError(400, 'SuperAdmin must pass ?companyId= for the audit log.');
    const limit = Math.min(Math.max(Number(q.limit) || 200, 1), 1000);
    const r = await query<AuditRow>(
      `SELECT id, at, actor_id, actor_name, action, entity, entity_id, detail
       FROM audit WHERE company_id = $1 ORDER BY at DESC LIMIT $2`,
      [companyId, limit],
    );
    return reply.send(r.rows.map(toLog));
  });

  app.post('/api/audit', pre, async (req, reply) => {
    const user = req.hrmsUser;
    const q = (req.query ?? {}) as { companyId?: string };
    const h = req.headers['x-company-id'];
    const companyId = resolveCompanyScope(user, q.companyId ?? (typeof h === 'string' && h ? h : undefined));
    const body = (req.body ?? {}) as { action?: string; entity?: string; entityId?: string; detail?: string };
    if (!body.action || !body.entity) {
      return reply.code(400).send({ error: 'action and entity are required.' });
    }
    if (!companyId) throw new HttpError(400, 'SuperAdmin must pass ?companyId= when appending audit entries.');
    await insertAudit({
      companyId,
      actorId: user.userId,
      actorName: user.username,
      action: String(body.action),
      entity: String(body.entity),
      entityId: body.entityId ? String(body.entityId) : undefined,
      detail: body.detail ? String(body.detail) : undefined,
    });
    return reply.code(201).send({ ok: true });
  });
}
