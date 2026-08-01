/**
 * JWT auth plugin — verifies the Bearer token and exposes `request.hrmsUser`.
 * Token payload (signed for JWT_TTL, default 12h):
 *   { userId, username, role, companyId, employeeId? }
 */
import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';
import type { JwtUser } from '../db/collections';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtUser;
    user: JwtUser;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    hrmsUser: JwtUser;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export default fp(async (app) => {
  await app.register(jwt, {
    secret: config.jwtSecret,
    sign: { expiresIn: config.jwtTtl },
  });

  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Missing or invalid access token.' });
    }
    req.hrmsUser = req.user;
  });
});
