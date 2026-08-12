import {
  Injectable, Inject, NotFoundException, UnauthorizedException, ConflictException, BadRequestException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { DATABASE_CLIENT } from '../database/database.module';

@Injectable()
export class LojasService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
  ) {}

  async buscarMinha(lojaId: string) {
    const [loja] = await this.sql`
      SELECT id, nome, email, modelo_mensagem, confirmar_leitura_wa FROM lojas WHERE id = ${lojaId}
    `;
    if (!loja) throw new NotFoundException('Loja não encontrada');
    return loja;
  }

  async atualizarModeloMensagem(lojaId: string, modeloMensagem: string) {
    const [atualizado] = await this.sql`
      UPDATE lojas
      SET modelo_mensagem = ${modeloMensagem}, updated_at = NOW()
      WHERE id = ${lojaId}
      RETURNING id, nome, modelo_mensagem, confirmar_leitura_wa
    `;
    if (!atualizado) throw new NotFoundException('Loja não encontrada');
    return atualizado;
  }

  async atualizarConfiguracaoInbox(lojaId: string, confirmarLeituraWa: boolean) {
    const [atualizado] = await this.sql`
      UPDATE lojas
      SET confirmar_leitura_wa = ${confirmarLeituraWa}, updated_at = NOW()
      WHERE id = ${lojaId}
      RETURNING id, confirmar_leitura_wa
    `;
    if (!atualizado) throw new NotFoundException('Loja não encontrada');
    return atualizado;
  }

  async atualizarPerfil(
    usuarioId: string,
    lojaId: string,
    dto: { nomeUsuario?: string; nomeLoja?: string },
  ) {
    if (dto.nomeUsuario !== undefined) {
      await this.sql`
        UPDATE usuarios SET nome = ${dto.nomeUsuario}, updated_at = NOW()
        WHERE id = ${usuarioId}
      `;
    }
    if (dto.nomeLoja !== undefined) {
      await this.sql`
        UPDATE lojas SET nome = ${dto.nomeLoja}, updated_at = NOW()
        WHERE id = ${lojaId}
      `;
    }
    const [usuario] = await this.sql`
      SELECT u.id, u.nome AS nome_usuario, u.email, l.nome AS nome_loja
      FROM usuarios u LEFT JOIN lojas l ON l.id = u.loja_id
      WHERE u.id = ${usuarioId}
    `;
    return usuario;
  }

  async alterarEmail(usuarioId: string, novoEmail: string, senhaAtual: string) {
    const [usuario] = await this.sql`
      SELECT id, senha_hash FROM usuarios WHERE id = ${usuarioId} AND deleted_at IS NULL
    `;
    if (!usuario) throw new NotFoundException('Usuário não encontrado');

    const senhaOk = await bcrypt.compare(senhaAtual, usuario.senhaHash);
    if (!senhaOk) throw new UnauthorizedException('Senha atual incorreta');

    const [existente] = await this.sql`
      SELECT id FROM usuarios WHERE email = ${novoEmail} AND deleted_at IS NULL AND id != ${usuarioId}
    `;
    if (existente) throw new ConflictException('E-mail já está em uso');

    await this.sql`
      UPDATE usuarios SET email = ${novoEmail}, updated_at = NOW() WHERE id = ${usuarioId}
    `;
    return { email: novoEmail };
  }

  async alterarSenha(usuarioId: string, senhaAtual: string, novaSenha: string) {
    const [usuario] = await this.sql`
      SELECT id, senha_hash FROM usuarios WHERE id = ${usuarioId} AND deleted_at IS NULL
    `;
    if (!usuario) throw new NotFoundException('Usuário não encontrado');

    const senhaOk = await bcrypt.compare(senhaAtual, usuario.senhaHash);
    if (!senhaOk) throw new UnauthorizedException('Senha atual incorreta');

    if (novaSenha.length < 6) throw new BadRequestException('A nova senha deve ter pelo menos 6 caracteres');

    const novoHash = await bcrypt.hash(novaSenha, 12);
    await this.sql`
      UPDATE usuarios SET senha_hash = ${novoHash}, updated_at = NOW() WHERE id = ${usuarioId}
    `;
    return { ok: true };
  }

  async excluirConta(usuarioId: string, lojaId: string, nomeLojaDig: string) {
    const [loja] = await this.sql`
      SELECT id, nome FROM lojas WHERE id = ${lojaId} AND deleted_at IS NULL
    `;
    if (!loja) throw new NotFoundException('Loja não encontrada');

    if (loja.nome.trim().toLowerCase() !== nomeLojaDig.trim().toLowerCase()) {
      throw new BadRequestException('Nome da loja não confere');
    }

    await this.sql`
      UPDATE lojas
      SET ativa = FALSE, deleted_at = NOW(), updated_at = NOW()
      WHERE id = ${lojaId}
    `;
    await this.sql`
      UPDATE usuarios
      SET ativo = FALSE, deleted_at = NOW(), updated_at = NOW()
      WHERE loja_id = ${lojaId}
    `;
    return { ok: true };
  }
}
