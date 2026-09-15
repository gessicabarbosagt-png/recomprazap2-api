import { Injectable, Inject, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { DATABASE_CLIENT } from '../database/database.module';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    @Inject(DATABASE_CLIENT) private readonly sql: any,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        // Cookie HttpOnly tem prioridade (fluxo web principal)
        (req) => (req?.cookies as Record<string, string> | undefined)?.recomprazap_token ?? null,
        // Bearer token como fallback (Postman, scripts, acesso direto à API)
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET'),
    });
  }

  // O que validate retornar fica disponível como req.user em todo o sistema
  async validate(payload: { sub: string; lojaId: string; perfil: string; role?: string; jti?: string }) {
    let role = payload.role ?? null;

    if (!role) {
      const [u] = await this.sql`
        SELECT role FROM usuarios WHERE id = ${payload.sub} AND deleted_at IS NULL
      `.catch(() => [undefined]);
      role = u?.role ?? 'lojista';
    }

    if (!payload.jti) {
      throw new UnauthorizedException('Token sem sessão — faça login novamente');
    }

    const [sessao] = await this.sql`
      SELECT id FROM sessoes_ativas
      WHERE jti = ${payload.jti}
        AND revogado_em IS NULL
        AND expires_at > NOW()
    `.catch(() => [undefined]);

    if (!sessao) {
      throw new UnauthorizedException('Sessão revogada ou expirada');
    }

    return {
      id: payload.sub,
      lojaId: payload.lojaId ?? null,
      perfil: payload.perfil,
      role,
      jti: payload.jti,
    };
  }
}
