import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

export class AppError extends Error {
  statusCode: number;
  code: string;
  details?: unknown;

  constructor(message: string, statusCode = 400, code = 'BAD_REQUEST', details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      success: false,
      code: 'VALIDATION_ERROR',
      message: err.issues[0]?.message || 'Validation failed',
      errors: err.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message
      }))
    });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      success: false,
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {})
    });
    return;
  }

  const message = err instanceof Error ? err.message : 'Internal server error';
  if (process.env.NODE_ENV !== 'test') {
    console.error('[API Error]', err);
  }

  res.status(500).json({
    success: false,
    code: 'INTERNAL_ERROR',
    message: process.env.NODE_ENV === 'production' ? 'Internal server error' : message
  });
}
