import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import logger from '../utils/logger.js';
import { captureServerError } from '../utils/error-tracking.js';

export interface ApiError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

function findDatabaseError(err: unknown): Record<string, unknown> | null {
  let current = err;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const candidate = current as Record<string, unknown>;
    if (candidate.code === 'P0001') {
      return candidate;
    }
    current = candidate.cause;
  }
  return null;
}

export function notFound(_req: Request, _res: Response, next: NextFunction): void {
  next(new AppError(404, 'NOT_FOUND', 'The requested resource was not found'));
}

export function errorHandler(err: Error, req: Request, res: Response, _next: NextFunction): void {
  // Zod validation errors
  if (err instanceof ZodError) {
    res.status(400).json({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: err.errors.map((e) => ({
        path: e.path.join('.'),
        message: e.message,
        code: e.code,
      })),
    } satisfies ApiError);
    return;
  }

  // Known application errors
  if (err instanceof AppError) {
    res.status(err.status).json({
      status: err.status,
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    } satisfies ApiError);
    return;
  }

  const databaseError = findDatabaseError(err);
  const databaseMessage = typeof databaseError?.message === 'string' ? databaseError.message : '';
  if (
    databaseError?.code === 'P0001' &&
    (databaseMessage.includes('TASK_CHECKOUT_ACTIVE') ||
      databaseMessage.includes('TASK_DEPENDENCY_ACTIVE'))
  ) {
    res.status(409).json({
      status: 409,
      code: 'TASK_CHECKOUT_CONFLICT',
      message: databaseMessage.includes('TASK_DEPENDENCY_ACTIVE')
        ? 'A checked-out task still depends on this completed task'
        : 'Release or terminate the active execution before changing task status',
      ...(typeof databaseError.detail === 'string'
        ? { details: { reason: databaseError.detail } }
        : {}),
    } satisfies ApiError);
    return;
  }

  // Unexpected errors
  captureServerError(err, req);
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({
    status: 500,
    code: 'INTERNAL_SERVER_ERROR',
    message: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred' : err.message,
  } satisfies ApiError);
}
