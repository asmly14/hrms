/**
 * POST /auth/login — bcrypt verify → JWT (12h) with {userId, companyId, role}.
 * GET  /auth/me    — current token's user profile.
 */
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { query } from '../db/pool';
import { config } from '../config';
import type { Role } from '../db/collections';

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: Role;
  company_id: string | null;
  employee_id: string | null;
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/auth/login',
    {
      config: {
        rateLimit: {
          max: config.loginRateLimitMax,
          timeWindow: '1 minute',
        },
      },
    },
    async (req, reply) => {
      const body = (req.body ?? {}) as { username?: string; password?: string };
      const username = (body.username ?? '').trim();
      const password = body.password ?? '';
      if (!username || !password) {
        return reply.code(400).send({ error: 'Please enter both username and password.' });
      }
      const r = await query<UserRow>(
        'SELECT id, username, password_hash, role, company_id, employee_id FROM users WHERE lower(username) = lower($1)',
        [username],
      );
      const account = r.rows[0];
      // Constant-shape failure path: never reveal which half was wrong.
      const ok = account ? await bcrypt.compare(password, account.password_hash) : false;
      if (!account || !ok) {
        return reply.code(401).send({ error: 'Invalid username or password.' });
      }
      const payload = {
        userId: account.id,
        username: account.username,
        role: account.role,
        companyId: account.company_id,
        employeeId: account.employee_id ?? undefined,
      };
      const token = app.jwt.sign(payload);
      return reply.send({
        token,
        expiresIn: config.jwtTtl,
        user: {
          id: account.id,
          username: account.username,
          role: account.role,
          companyId: account.company_id,
          employeeId: account.employee_id ?? undefined,
        },
      });
    },
  );

  app.get('/auth/me', { preHandler: [app.authenticate] }, async (req) => {
    const u = req.hrmsUser;
    return {
      id: u.userId,
      username: u.username,
      role: u.role,
      companyId: u.companyId,
      employeeId: u.employeeId,
    };
  });
}
