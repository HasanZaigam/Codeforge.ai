import type { NextFunction, Request, Response } from "express";

/** Express 4 does not forward rejected promises to error middleware on its own — this closes that gap. */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
}
