import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

interface RequestWithId extends Request {
  requestId?: string;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<RequestWithId>();
    const requestId = request.requestId ?? 'unknown';
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const responseBody =
      exception instanceof HttpException ? exception.getResponse() : undefined;
    const body =
      typeof responseBody === 'object' && responseBody !== null
        ? (responseBody as Record<string, unknown>)
        : undefined;
    const messages = body?.message;
    const details =
      body?.details ??
      (Array.isArray(messages) ? messages : undefined);
    const message =
      typeof messages === 'string'
        ? messages
        : status >= HttpStatus.INTERNAL_SERVER_ERROR
          ? 'Internal server error'
          : Array.isArray(messages)
            ? 'Request validation failed'
            : typeof responseBody === 'string'
              ? responseBody
              : 'Request failed';
    const code =
      typeof body?.code === 'string'
        ? body.code
        : status === HttpStatus.BAD_REQUEST
          ? 'validation_error'
          : status === HttpStatus.UNAUTHORIZED
            ? 'unauthorized'
            : status === HttpStatus.FORBIDDEN
              ? 'forbidden'
              : status === HttpStatus.NOT_FOUND
                ? 'not_found'
                : status === HttpStatus.CONFLICT
                  ? 'conflict'
                  : status === HttpStatus.SERVICE_UNAVAILABLE
                    ? 'service_unavailable'
                    : status >= HttpStatus.INTERNAL_SERVER_ERROR
                      ? 'internal_error'
                      : 'request_failed';

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR && exception instanceof Error) {
      this.logger.error(`Unhandled API error for request ${requestId}`, exception.stack);
    }

    response.status(status).json({
      error: {
        code,
        message,
        requestId,
        details: details ?? null,
      },
    });
  }
}
