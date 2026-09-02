import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Request } from 'express';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Defense-in-depth contra CSRF: exige header customizado em todas as requisições
// que alteram dados e têm um cookie de sessão ativo.
//
// Por que funciona: o browser nunca envia headers customizados cross-origin sem
// aprovação explícita via CORS. Um formulário ou script de site malicioso não
// consegue adicionar X-Requested-With sem que o preflight OPTIONS seja bloqueado
// (a origem do atacante não está em allowedOrigins).
//
// Rotas isentas automaticamente:
//   - Métodos seguros (GET, HEAD, OPTIONS) → não alteram estado
//   - Requests sem cookie recomprazap_token → sem sessão para sequestrar
//     (cobre: POST /auth/login, POST /webhooks/mercadopago)
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();

    if (!MUTATING_METHODS.has(req.method)) return true;

    const cookies = req.cookies as Record<string, string> | undefined;
    if (!cookies?.recomprazap_token) return true;

    if (req.headers['x-requested-with'] === 'XMLHttpRequest') return true;

    throw new ForbiddenException('CSRF check failed');
  }
}
