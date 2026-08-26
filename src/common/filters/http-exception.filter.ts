import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx  = host.switchToHttp();
    const req  = ctx.getRequest<Request>();
    const res  = ctx.getResponse<Response>();

    const isHttpException = exception instanceof HttpException;
    const status = isHttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    // 4xx esperados: retorna a mensagem original (já são seguras para o cliente)
    if (isHttpException && status < 500) {
      const response = exception.getResponse();
      const body = typeof response === 'string'
        ? { statusCode: status, message: response }
        : { statusCode: status, ...(response as object) };
      return res.status(status).json(body);
    }

    // 5xx: loga detalhes no servidor, retorna mensagem genérica para o cliente
    const isProd = process.env.NODE_ENV === 'production';

    const errorDetail = exception instanceof Error
      ? exception.stack ?? exception.message
      : String(exception);

    this.logger.error(
      `[${req.method}] ${req.url} → ${status}`,
      errorDetail,
    );

    if (isProd) {
      return res.status(status).json({
        statusCode: status,
        message: 'Erro interno do servidor',
      });
    }

    // Ambiente de desenvolvimento: retorna detalhes completos para debug
    return res.status(status).json({
      statusCode: status,
      message: exception instanceof Error ? exception.message : 'Erro interno do servidor',
      stack: exception instanceof Error ? exception.stack : undefined,
    });
  }
}
