/**
 * Generic tenant-scoped CRUD: /api/:collection[/:id]
 *
 * Mirrors the web app's localStorage semantics (hrms-web/src/lib/db.ts):
 *   GET    /api/:collection            → getCollection(name)
 *   PUT    /api/:collection            → setCollection(name, items)  [replace-all]
 *   GET    /api/:collection/:id        → single record
 *   POST   /api/:collection            → create (server assigns id when omitted)
 *   PATCH  /api/:collection/:id        → shallow-merge patch
 *   DELETE /api/:collection/:id        → remove
 *
 * Tenant scope: company users are pinned to their JWT companyId; SuperAdmin
 * passes ?companyId= or the x-company-id header. Role scoping mirrors
 * docs/auth-integration.md §4 (Admin/HR all-in-company, Manager own
 * department, Employee self).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  HttpError,
  assertWriteAllowed,
  collectionDef,
  deleteDoc,
  getDoc,
  listDocs,
  replaceCollection,
  resolveCompanyScope,
  upsertDoc,
  visibilityFilter,
} from '../db/collections';
import { withTransaction } from '../db/pool';
import { insertAudit } from '../lib/audit';

function requestedCompany(req: FastifyRequest): string | undefined {
  const q = (req.query ?? {}) as { companyId?: string };
  const h = req.headers['x-company-id'];
  return q.companyId ?? (typeof h === 'string' && h ? h : undefined);
}

function handleError(reply: { code: (n: number) => { send: (b: unknown) => unknown } }, err: unknown): unknown {
  if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
  throw err;
}

export default async function collectionRoutes(app: FastifyInstance): Promise<void> {
  const pre = { preHandler: [app.authenticate] };

  app.get('/api/:collection', pre, async (req, reply) => {
    try {
      const { collection } = req.params as { collection: string };
      const def = collectionDef(collection);
      if (!def) throw new HttpError(404, `Unknown collection '${collection}'.`);
      const user = req.hrmsUser;
      const companyId = resolveCompanyScope(user, requestedCompany(req));
      if (!def.global && !companyId) throw new HttpError(400, 'SuperAdmin must pass ?companyId= (or x-company-id) for tenant collections.');
      const filter =
        def.global || !companyId
          ? { sql: '', params: [] }
          : await visibilityFilter(user, def, companyId, def.global ? 1 : 2);
      return reply.send(await listDocs(def, companyId, filter));
    } catch (err) {
      return handleError(reply, err);
    }
  });

  app.get('/api/:collection/:id', pre, async (req, reply) => {
    try {
      const { collection, id } = req.params as { collection: string; id: string };
      const def = collectionDef(collection);
      if (!def) throw new HttpError(404, `Unknown collection '${collection}'.`);
      const user = req.hrmsUser;
      const companyId = resolveCompanyScope(user, requestedCompany(req));
      if (!def.global && !companyId) throw new HttpError(400, 'SuperAdmin must pass ?companyId= for tenant collections.');
      const doc = await getDoc(def, companyId, id);
      if (!doc) throw new HttpError(404, 'Record not found.');
      // Reuse the list filter to enforce row-level visibility on direct access.
      if (!def.global && companyId) {
        const filter = await visibilityFilter(user, def, companyId, 2);
        const visible = await listDocs(def, companyId, filter);
        if (!visible.some((d) => d.id === id)) throw new HttpError(404, 'Record not found.');
      }
      return reply.send(doc);
    } catch (err) {
      return handleError(reply, err);
    }
  });

  app.post('/api/:collection', pre, async (req, reply) => {
    try {
      const { collection } = req.params as { collection: string };
      const def = collectionDef(collection);
      if (!def) throw new HttpError(404, `Unknown collection '${collection}'.`);
      const user = req.hrmsUser;
      const companyId = resolveCompanyScope(user, requestedCompany(req));
      if (!def.global && !companyId) throw new HttpError(400, 'SuperAdmin must pass ?companyId= for tenant collections.');
      const doc = (req.body ?? {}) as Record<string, unknown>;
      if (typeof doc !== 'object' || Array.isArray(doc)) throw new HttpError(400, 'Body must be a JSON object.');
      await assertWriteAllowed(user, def, companyId ?? '', doc);
      const stored = await upsertDoc(def, companyId, doc);
      await insertAudit({
        companyId: companyId ?? null,
        actorId: user.userId,
        actorName: user.username,
        action: `${collection}.create`,
        entity: collection,
        entityId: stored.id as string,
      });
      return reply.code(201).send(stored);
    } catch (err) {
      return handleError(reply, err);
    }
  });

  app.patch('/api/:collection/:id', pre, async (req, reply) => {
    try {
      const { collection, id } = req.params as { collection: string; id: string };
      const def = collectionDef(collection);
      if (!def) throw new HttpError(404, `Unknown collection '${collection}'.`);
      const user = req.hrmsUser;
      const companyId = resolveCompanyScope(user, requestedCompany(req));
      if (!def.global && !companyId) throw new HttpError(400, 'SuperAdmin must pass ?companyId= for tenant collections.');
      const existing = await getDoc(def, companyId, id);
      if (!existing) throw new HttpError(404, 'Record not found.');
      const patch = (req.body ?? {}) as Record<string, unknown>;
      const merged = { ...existing, ...patch, id };
      await assertWriteAllowed(user, def, companyId ?? '', merged);
      const stored = await upsertDoc(def, companyId, merged);
      await insertAudit({
        companyId: companyId ?? null,
        actorId: user.userId,
        actorName: user.username,
        action: `${collection}.update`,
        entity: collection,
        entityId: id,
      });
      return reply.send(stored);
    } catch (err) {
      return handleError(reply, err);
    }
  });

  app.put('/api/:collection', pre, async (req, reply) => {
    try {
      const { collection } = req.params as { collection: string };
      const def = collectionDef(collection);
      if (!def) throw new HttpError(404, `Unknown collection '${collection}'.`);
      const user = req.hrmsUser;
      // setCollection() is a whole-collection replace — privileged roles only.
      if (user.role !== 'Admin' && user.role !== 'HR' && user.role !== 'SuperAdmin') {
        throw new HttpError(403, 'Only Admin/HR can replace an entire collection.');
      }
      const companyId = resolveCompanyScope(user, requestedCompany(req));
      if (!def.global && !companyId) throw new HttpError(400, 'SuperAdmin must pass ?companyId= for tenant collections.');
      const docs = req.body as Record<string, unknown>[];
      if (!Array.isArray(docs)) throw new HttpError(400, 'Body must be a JSON array of records.');
      await withTransaction(async (client) => {
        await replaceCollection(def, companyId, docs, client);
      });
      await insertAudit({
        companyId: companyId ?? null,
        actorId: user.userId,
        actorName: user.username,
        action: `${collection}.replace`,
        entity: collection,
        detail: `${docs.length} records`,
      });
      return reply.send({ ok: true, count: docs.length });
    } catch (err) {
      return handleError(reply, err);
    }
  });

  app.delete('/api/:collection/:id', pre, async (req, reply) => {
    try {
      const { collection, id } = req.params as { collection: string; id: string };
      const def = collectionDef(collection);
      if (!def) throw new HttpError(404, `Unknown collection '${collection}'.`);
      const user = req.hrmsUser;
      // Deletes are destructive — Admin/HR/SuperAdmin only (no self-service).
      if (user.role !== 'Admin' && user.role !== 'HR' && user.role !== 'SuperAdmin') {
        throw new HttpError(403, 'Only Admin/HR can delete records.');
      }
      const companyId = resolveCompanyScope(user, requestedCompany(req));
      if (!def.global && !companyId) throw new HttpError(400, 'SuperAdmin must pass ?companyId= for tenant collections.');
      const removed = await deleteDoc(def, companyId, id);
      if (!removed) throw new HttpError(404, 'Record not found.');
      await insertAudit({
        companyId: companyId ?? null,
        actorId: user.userId,
        actorName: user.username,
        action: `${collection}.delete`,
        entity: collection,
        entityId: id,
      });
      return reply.send({ ok: true });
    } catch (err) {
      return handleError(reply, err);
    }
  });
}
