import { Injectable, ExecutionContext } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Request } from 'express';

// Guard temporário para diagnóstico do rate-limiting no Railway.
// Remove este arquivo e reverta app.module.ts após confirmar o IP correto nos logs.
@Injectable()
export class ThrottlerDebugGuard extends ThrottlerGuard {
  override async getTracker(req: Request): Promise<string> {
    const ip = req.ip ?? 'unknown';
    const forwarded = req.headers['x-forwarded-for'];
    const remoteAddress = req.socket?.remoteAddress ?? 'unknown';

    console.log('[ThrottlerDebug] ip=%s | x-forwarded-for=%s | socket.remoteAddress=%s', ip, forwarded, remoteAddress);

    return ip;
  }
}
