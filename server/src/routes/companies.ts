/**
 * /api/companies — the global tenant directory.
 *   GET    /api/companies       SuperAdmin: all; company users: just their own.
 *   GET    /api/companies/:id   own company or SuperAdmin.
 *   POST   /api/companies       SuperAdmin only.
 *   PATCH  /api/companies/:id   SuperAdmin, or Admin/HR of that company
 *                               (config/branding edits — plan/status stay SuperAdmin-only).
 */
import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool';
import { uid } from '../calc/utils';
import { insertAudit } from '../lib/audit';

interface CompanyRow {
  id: string;
  code: string;
  name: string;
  reg_no: string;
  hq_state: string;
  status: string;
  plan: string;
  branding: Record<string, unknown>;
  config: Record<string, unknown>;
  created_at: string;
}

function toCompany(r: CompanyRow): Record<string, unknown> {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    regNo: r.reg_no,
    hqState: r.hq_state,
    status: r.status,
    plan: r.plan,
    createdAt: r.created_at,
    branding: r.branding,
    config: r.config,
  };
}

const SELECT = 'SELECT id, code, name, reg_no, hq_state, status, plan, branding, config, created_at FROM companies';

export default async function companyRoutes(app: FastifyInstance): Promise<void> {
  const pre = { preHandler: [app.authenticate] };

  app.get('/api/companies', pre, async (req, reply) => {
    const user = req.hrmsUser;
    if (user.role === 'SuperAdmin') {
      const r = await query<CompanyRow>(`${SELECT} ORDER BY created_at ASC`);
      return reply.send(r.rows.map(toCompany));
    }
    const r = await query<CompanyRow>(`${SELECT} WHERE id = $1`, [user.companyId]);
    return reply.send(r.rows.map(toCompany));
  });

  app.get('/api/companies/:id', pre, async (req, reply) => {
    const user = req.hrmsUser;
    const { id } = req.params as { id: string };
    if (user.role !== 'SuperAdmin' && user.companyId !== id) {
      return reply.code(403).send({ error: 'Cross-company access is not permitted for this account.' });
    }
    const r = await query<CompanyRow>(`${SELECT} WHERE id = $1`, [id]);
    if (!r.rows[0]) return reply.code(404).send({ error: 'Company not found.' });
    return reply.send(toCompany(r.rows[0]));
  });

  app.post('/api/companies', pre, async (req, reply) => {
    const user = req.hrmsUser;
    if (user.role !== 'SuperAdmin') return reply.code(403).send({ error: 'Only SuperAdmin can create companies.' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!body.name || !body.code) return reply.code(400).send({ error: 'name and code are required.' });
    const id = (body.id as string) || `co-${uid().slice(0, 8)}`;
    await query(
      `INSERT INTO companies (id, code, name, reg_no, hq_state, status, plan, branding, config)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        String(body.code),
        String(body.name),
        String(body.regNo ?? ''),
        String(body.hqState ?? 'KUL'),
        String(body.status ?? 'active'),
        String(body.plan ?? 'free'),
        JSON.stringify(body.branding ?? {}),
        JSON.stringify(body.config ?? {}),
      ],
    );
    await insertAudit({
      companyId: null,
      actorId: user.userId,
      actorName: user.username,
      action: 'companies.create',
      entity: 'companies',
      entityId: id,
      detail: String(body.name),
    });
    const r = await query<CompanyRow>(`${SELECT} WHERE id = $1`, [id]);
    return reply.code(201).send(toCompany(r.rows[0]!));
  });

  app.patch('/api/companies/:id', pre, async (req, reply) => {
    const user = req.hrmsUser;
    const { id } = req.params as { id: string };
    const isSuper = user.role === 'SuperAdmin';
    const isOwnAdmin = (user.role === 'Admin' || user.role === 'HR') && user.companyId === id;
    if (!isSuper && !isOwnAdmin) return reply.code(403).send({ error: 'Not permitted.' });
    const body = (req.body ?? {}) as Record<string, unknown>;
    // plan/status changes gate billing + access — SuperAdmin only.
    if (!isSuper && (body.plan !== undefined || body.status !== undefined)) {
      return reply.code(403).send({ error: 'Only SuperAdmin can change plan or status.' });
    }
    const existing = await query<CompanyRow>(`${SELECT} WHERE id = $1`, [id]);
    if (!existing.rows[0]) return reply.code(404).send({ error: 'Company not found.' });
    const cur = existing.rows[0];
    await query(
      `UPDATE companies SET
         code = $2, name = $3, reg_no = $4, hq_state = $5, status = $6, plan = $7,
         branding = $8, config = $9, updated_at = now()
       WHERE id = $1`,
      [
        id,
        String(body.code ?? cur.code),
        String(body.name ?? cur.name),
        String(body.regNo ?? cur.reg_no),
        String(body.hqState ?? cur.hq_state),
        String(body.status ?? cur.status),
        String(body.plan ?? cur.plan),
        JSON.stringify(body.branding ?? cur.branding),
        JSON.stringify(body.config ?? cur.config),
      ],
    );
    await insertAudit({
      companyId: id,
      actorId: user.userId,
      actorName: user.username,
      action: 'companies.update',
      entity: 'companies',
      entityId: id,
    });
    const r = await query<CompanyRow>(`${SELECT} WHERE id = $1`, [id]);
    return reply.send(toCompany(r.rows[0]!));
  });
}
