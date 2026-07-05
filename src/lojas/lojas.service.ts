import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { DATABASE_CLIENT } from '../database/database.module';

@Injectable()
export class LojasService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
  ) {}

  async buscarMinha(lojaId: string) {
    const [loja] = await this.sql`
      SELECT id, nome, email, modelo_mensagem FROM lojas WHERE id = ${lojaId}
    `;
    if (!loja) throw new NotFoundException('Loja não encontrada');
    return loja;
  }

  async atualizarModeloMensagem(lojaId: string, modeloMensagem: string) {
    const [atualizado] = await this.sql`
      UPDATE lojas
      SET modelo_mensagem = ${modeloMensagem}, updated_at = NOW()
      WHERE id = ${lojaId}
      RETURNING id, nome, modelo_mensagem
    `;
    if (!atualizado) throw new NotFoundException('Loja não encontrada');
    return atualizado;
  }
}
