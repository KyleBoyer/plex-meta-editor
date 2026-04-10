import type { Request, Response, NextFunction } from 'express';

export interface ApiError extends Error {
  status?: number;
}

export function errorHandler(err: ApiError, _req: Request, res: Response, _next: NextFunction) {
  const status = err.status || 500;
  const message = err.message || 'Internal server error';

  console.error(`[${status}] ${message}`);
  if (status === 500) {
    console.error(err.stack);
  }

  res.status(status).json({
    success: false,
    error: message,
  });
}

/** Create an API error with a status code */
export function createError(message: string, status: number = 500): ApiError {
  const err = new Error(message) as ApiError;
  err.status = status;
  return err;
}
