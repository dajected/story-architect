import type { RequestHandler } from 'express';
import type { z } from 'zod';
import { badRequest } from '../errors.js';

export function wrap(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw badRequest(result.error.issues[0]?.message ?? 'Invalid request body.');
  }
  return result.data;
}

export function stringParam(value: string | string[] | undefined, name: string): string {
  if (typeof value !== 'string' || !value) throw badRequest(`Missing ${name}.`);
  return value;
}
