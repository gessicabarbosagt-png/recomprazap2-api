import {
  Injectable, UnauthorizedException, BadRequestException,
  Inject, Logger, NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { DATABASE_CLIENT } from '../database/database.module';
import { EmailService } from '../email/email.service';
import { LoginDto } from './dto/login.dto';
import { UsuarioLogado } from '../common/decorators/usuario-atual.decorator';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
    private readonly jwtService: JwtService,
    private readonly emailService: EmailService,
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

  // ── Redefinição de senha ─────────────────────────────────────────────────────

  private gerarTokenRedefinicao(): { rawToken: string; tokenHash: string; expiraEm: Date } {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiraEm = new Date(Date.now() + 60 * 60 * 1000); // 1 hora
    return { rawToken, tokenHash, expiraEm };
  }

  async esqueceuSenha(email: string): Promise<void> {
    const RESPOSTA_GENERICA = undefined; // sempre retorna sucesso, sem revelar se e-mail existe

    const [usuario] = await this.sql`
      SELECT id, nome, email FROM usuarios
      WHERE email = ${email} AND deleted_at IS NULL AND ativo = TRUE
    `;

    if (!usuario) {
      this.logger.log(`[ESQUECI_SENHA] e-mail não encontrado: ${email} — resposta genérica`);
      return RESPOSTA_GENERICA;
    }

    const { rawToken, tokenHash, expiraEm } = this.gerarTokenRedefinicao();

    await this.sql`
      UPDATE usuarios
      SET token_redefinicao = ${tokenHash}, token_expira_em = ${expiraEm}, updated_at = NOW()
      WHERE id = ${usuario.id}
    `;

    await this.emailService.enviarRedefinicaoSenha(usuario.email, rawToken);
    this.logger.log(`[ESQUECI_SENHA] link enviado para ${email}`);

    return RESPOSTA_GENERICA;
  }

  async redefinirSenha(rawToken: string, novaSenha: string): Promise<void> {
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

    const [usuario] = await this.sql`
      SELECT id FROM usuarios
      WHERE token_redefinicao = ${tokenHash}
        AND token_expira_em > NOW()
        AND deleted_at IS NULL
        AND ativo = TRUE
    `;

    if (!usuario) {
      throw new BadRequestException('Token inválido ou expirado. Solicite um novo link.');
    }

    const senhaHash = await bcrypt.hash(novaSenha, 12);

    await this.sql`
      UPDATE usuarios
      SET senha_hash        = ${senhaHash},
          token_redefinicao = NULL,
          token_expira_em   = NULL,
          email_confirmado  = TRUE,
          updated_at        = NOW()
      WHERE id = ${usuario.id}
    `;

    this.logger.log(`[REDEFINIR_SENHA] senha atualizada para usuario id=${usuario.id}`);
  }

  async getMe(payload: UsuarioLogado) {
    const [usuario] = await this.sql`
      SELECT u.id, u.nome, u.email, u.perfil, u.role, u.loja_id, l.nome as loja_nome
      FROM usuarios u
      LEFT JOIN lojas l ON l.id = u.loja_id
      WHERE u.id = ${payload.id}
        AND u.deleted_at IS NULL
        AND u.ativo = TRUE
    `;

    if (!usuario) throw new NotFoundException('Usuário não encontrado');

    return {
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      perfil: usuario.perfil,
      role: usuario.role ?? 'lojista',
      loja: usuario.lojaId ? { id: usuario.lojaId, nome: usuario.lojaNome } : null,
    };
  }
}
