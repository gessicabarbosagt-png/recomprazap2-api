import { Injectable, UnauthorizedException, Inject } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { DATABASE_CLIENT } from '../database/database.module';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
    private readonly jwtService: JwtService,
  ) {}

  async login(loginDto: LoginDto) {
    const { email, senha } = loginDto;

    // 1. Busca o usuário pelo email (junto com a loja para pegar o loja_id)
    const [usuario] = await this.sql`
      SELECT u.id, u.nome, u.email, u.senha_hash, u.perfil, u.loja_id, l.nome as loja_nome
      FROM usuarios u
      JOIN lojas l ON l.id = u.loja_id
      WHERE u.email = ${email}
        AND u.deleted_at IS NULL
        AND u.ativo = TRUE
        AND l.ativa = TRUE
    `;

    // 2. Se não achou ou a senha não bate, retorna erro genérico
    // (nunca diga se foi o email ou a senha que errou — segurança)
    if (!usuario) {
      throw new UnauthorizedException('Credenciais inválidas');
    }

    const senhaCorreta = await bcrypt.compare(senha, usuario.senhaHash);
    if (!senhaCorreta) {
      throw new UnauthorizedException('Credenciais inválidas');
    }

    // 3. Gera o token JWT com os dados que precisamos em cada requisição
    // Esses dados ficam "dentro" do token e são lidos pelo JwtStrategy
    const payload = {
      sub: usuario.id,         // ID do usuário (sub = subject, padrão JWT)
      lojaId: usuario.lojaId,  // Fundamental para o RLS funcionar
      perfil: usuario.perfil,
    };

    return {
      accessToken: this.jwtService.sign(payload),
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        perfil: usuario.perfil,
        loja: {
          id: usuario.lojaId,
          nome: usuario.lojaNome,
        },
      },
    };
  }
}
