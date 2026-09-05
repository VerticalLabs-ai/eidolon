import type { Request, Response, NextFunction } from 'express';
import { toSafeMissionError } from '../services/mission/sanitize.js';

/**
 * Mission error sanitizer middleware (VAL-RUN-046).
 *
 * Mounted on the Mission runs router *before* the global `errorHandler`.
 * Any error thrown by a Mission route handler is converted to a safe
 * `AppError` (or passed through if `ZodError`) so the global handler
 * never serializes raw credentials, prompts, provider bodies, retrieved
 * content, or raw diagnostics into a user-visible API response.
 *
 * This is a defense-in-depth layer: Mission services already throw
 * `AppError` with safe messages for known failures. This middleware
 * catches the unexpected 500 case (database errors, provider failures,
 * programming bugs) where the raw `Error.message` might contain
 * sensitive data.
 *
 * It does **not** log or swallow the error — the original error is
 * still passed to the global handler for logging/tracking. It only
 * replaces the error object that reaches the response serializer.
 */
export function missionErrorSanitizer(
  err: Error,
  _req: Request,
  _res: Response,
  next: NextFunction,
): void {
  next(toSafeMissionError(err));
}
