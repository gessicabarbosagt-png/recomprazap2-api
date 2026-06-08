import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

// JwtStrategy é executada automaticamente pelo NestJS em toda rota
// que tiver o decorator @UseGuards(AuthGuard('jwt')).
// Ela lê o token do header Authorization: Bearer <token>,
// valida a assinatura e coloca o payload em req.user.

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      // Extrai o token do header: Authorization: Bearer <token>
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET'),
    });
  }

  // O que validate retornar fica disponível como req.user em todo o sistema
  async validate(payload: { sub: string; lojaId: string; perfil: string }) {
    return {
      id: payload.sub,
      lojaId: payload.lojaId,
      perfil: payload.perfil,
    };
  }
}
