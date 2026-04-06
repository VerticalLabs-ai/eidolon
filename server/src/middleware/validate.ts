import type { Request, Response, NextFunction } from 'express';
import type { ZodSchema, ZodTypeDef } from 'zod';

type ValidationTarget = 'body' | 'query' | 'params';

/**
 * Middleware factory that validates a request property against a Zod schema.
 * On success the parsed (and coerced) data is stored on `req.validated[target]`
 * and also on `req.body` when target is 'body'.
 */
export function validate<T>(
  schema: ZodSchema<T, ZodTypeDef, unknown>,
  target: ValidationTarget = 'body',
) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[target]);
    if (!result.success) {
      next(result.error); // caught by errorHandler as ZodError
      return;
    }
    // Store parsed data - use res.locals for query/params since they're read-only in Express 5
    if (target === 'body') {
      (req as any).body = result.data;
    } else {
      // Store on res.locals so handlers can access validated query/params
      if (!req.res) {
        // Fallback: store on request
        (req as any).validatedQuery = result.data;
      }
    }
    // Always store on a custom property for consistency
    (req as any).validated = (req as any).validated || {};
    (req as any).validated[target] = result.data;
    next();
  };
}
