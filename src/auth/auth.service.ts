import { Injectable, UnauthorizedException, Inject, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { DATABASE_CLIENT } from '../database/database.module';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
    private readonly jwtService: JwtService,
  ) {}

  async login(loginDto: LoginDto, ip: string) {
    const { email, senha } = loginDto;

    // LEFT JOIN: admin users have loja_id = NULL
    const [usuario] = await this.sql`
      SELECT u.id, u.nome, u.email, u.senha_hash, u.perfil, u.role, u.loja_id, l.nome as loja_nome
      FROM usuarios u
      LEFT JOIN lojas l ON l.id = u.loja_id
      WHERE u.email = ${email}
        AND u.deleted_at IS NULL
        AND u.ativo = TRUE
        AND (
          u.role = 'admin'
          OR (l.ativa = TRUE AND l.status_assinatura != 'cancelada')
        )
    `;

    if (!usuario) {
      this.logger.warn(`[LOGIN_FALHA] email="${email}" ip=${ip} motivo=usuario_nao_encontrado`);
      throw new UnauthorizedException('Credenciais inválidas');
    }

    const senhaCorreta = await bcrypt.compare(senha, usuario.senhaHash);
    if (!senhaCorreta) {
      this.logger.warn(`[LOGIN_FALHA] email="${email}" ip=${ip} motivo=senha_incorreta`);
      throw new UnauthorizedException('Credenciais inválidas');
    }

    const payload = {
      sub: usuario.id,
      lojaId: usuario.lojaId ?? null,
      perfil: usuario.perfil,
      role: usuario.role ?? 'lojista',
    };

    return {
      accessToken: this.jwtService.sign(payload),
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        perfil: usuario.perfil,
        role: usuario.role ?? 'lojista',
        loja: usuario.lojaId
          ? { id: usuario.lojaId, nome: usuario.lojaNome }
          : null,
      },
    };
  }
}
