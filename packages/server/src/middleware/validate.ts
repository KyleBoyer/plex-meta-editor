import { z } from 'zod';
import type { Request, Response, NextFunction } from 'express';
import { createError } from './error.js';

/**
 * Express middleware factory that validates the request body against a Zod schema.
 * Parsed (and typed) data is attached as req.body.
 */
export function validateBody<T extends z.ZodType>(schema: T) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const messages = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      return next(createError(`Validation error: ${messages}`, 400));
    }
    req.body = result.data;
    next();
  };
}

/**
 * Validate that a route parameter is a positive integer.
 */
export function validateIntParam(paramName: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const raw = req.params[paramName];
    const value = parseInt(typeof raw === 'string' ? raw : '', 10);
    if (isNaN(value) || value <= 0) {
      return next(createError(`Parameter "${paramName}" must be a positive integer`, 400));
    }
    next();
  };
}
