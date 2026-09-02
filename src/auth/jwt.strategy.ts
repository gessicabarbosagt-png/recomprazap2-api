import { Injectable, Inject } from '@nestjs/common';
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
  async validate(payload: { sub: string; lojaId: string; perfil: string; role?: string }) {
    let role = payload.role ?? null;

    if (!role) {
      // Token gerado antes do campo 'role' existir no payload (logins anteriores ao painel admin).
      // Busca o role atual do banco para não bloquear o usuário admin com token antigo.
      const [u] = await this.sql`
        SELECT role FROM usuarios WHERE id = ${payload.sub} AND deleted_at IS NULL
      `.catch(() => [undefined]);
      role = u?.role ?? 'lojista';
    }

    return {
      id: payload.sub,
      lojaId: payload.lojaId ?? null,
      perfil: payload.perfil,
      role,
    };
  }
}
