import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import logger from "../utils/logger.js";

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
    this.name = "AppError";
  }
}

export function notFound(
  _req: Request,
  _res: Response,
  next: NextFunction,
): void {
  next(new AppError(404, "NOT_FOUND", "The requested resource was not found"));
}

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  // Zod validation errors
  if (err instanceof ZodError) {
    res.status(400).json({
      status: 400,
      code: "VALIDATION_ERROR",
      message: "Request validation failed",
      details: err.errors.map((e) => ({
        path: e.path.join("."),
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

  // Unexpected errors
  logger.error({ err }, "Unhandled error");
  res.status(500).json({
    status: 500,
    code: "INTERNAL_SERVER_ERROR",
    message:
      process.env.NODE_ENV === "production"
        ? "An unexpected error occurred"
        : err.message,
  } satisfies ApiError);
}
