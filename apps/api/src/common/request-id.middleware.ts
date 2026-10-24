import { randomUUID } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';

interface RequestWithId extends Request {
  requestId?: string;
}

export class RequestIdMiddleware {
  use(request: RequestWithId, response: Response, next: NextFunction): void {
    const requestId = randomUUID();
    request.requestId = requestId;
    response.setHeader('X-Request-Id', requestId);
    next();
  }
}
