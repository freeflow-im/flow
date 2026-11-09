// The HTTP server the Docs routes register on: Fastify, on Node.
import Fastify from 'fastify';
export { Fastify };
export type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
export { default as cookie } from '@fastify/cookie';
export { default as fastifyStatic } from '@fastify/static';
