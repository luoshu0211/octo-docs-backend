import type { Request, Response, NextFunction } from 'express'
import { PptApiError } from '../ppt/errors.js'

export function documentAsync(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): Promise<void> => fn(req, res).catch(next)
}
/** Content adapters keep the common Docs error envelope. */
export function documentErrorHandler(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (!(error instanceof PptApiError) || res.headersSent) { next(error); return }
  res.status(error.httpStatus).json({ error: error.code, code: error.code, message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }) })
}
