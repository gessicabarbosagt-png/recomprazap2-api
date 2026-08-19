import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { DATABASE_CLIENT } from '../database/database.module';

@Injectable()
export class NotificacoesService {
  constructor(@Inject(DATABASE_CLIENT) private readonly sql: any) {}

  async listarNaoLidas(lojaId: string) {
    return this.sql`
      SELECT id, mensagem, tipo, criado_em
      FROM notificacoes_admin
      WHERE loja_id = ${lojaId} AND lida_em IS NULL
      ORDER BY criado_em DESC
    `;
  }

  async marcarComoLida(id: string, lojaId: string) {
    const [atualizado] = await this.sql`
      UPDATE notificacoes_admin
      SET lida_em = NOW()
      WHERE id = ${id} AND loja_id = ${lojaId}
      RETURNING id, lida_em
    `;
    if (!atualizado) throw new NotFoundException('Notificação não encontrada');
    return atualizado;
  }

  async criarParaLoja(lojaId: string, mensagem: string, tipo?: string) {
    const [loja] = await this.sql`
      SELECT id FROM lojas WHERE id = ${lojaId} AND deleted_at IS NULL
    `;
    if (!loja) throw new NotFoundException('Loja não encontrada');
    const [criada] = await this.sql`
      INSERT INTO notificacoes_admin (loja_id, mensagem, tipo)
      VALUES (${lojaId}, ${mensagem}, ${tipo ?? null})
      RETURNING id, loja_id, mensagem, tipo, criado_em
    `;
    return criada;
  }

  async criarAlertaFalhaSilenciosa(lojaId: string) {
    // Não duplica: só cria se não houver alerta desse tipo não lido para esta loja
    const [existente] = await this.sql`
      SELECT id FROM notificacoes_admin
      WHERE loja_id = ${lojaId}
        AND tipo = 'falha_silenciosa_inbox'
        AND lida_em IS NULL
    `;
    if (existente) return null;

    const [criada] = await this.sql`
      INSERT INTO notificacoes_admin (loja_id, mensagem, tipo)
      VALUES (
        ${lojaId},
        'Possível falha silenciosa no inbox: WhatsApp aparece conectado mas pode não estar recebendo mensagens individuais. Acesse Configurações e reconecte via QR se necessário.',
        'falha_silenciosa_inbox'
      )
      RETURNING id, loja_id, mensagem, tipo, criado_em
    `;
    return criada;
  }

  async criarParaDesconectadas(mensagem: string) {
    const lojas = await this.sql`
      SELECT id FROM lojas
      WHERE deleted_at IS NULL AND ativa = TRUE AND wa_status = 'desconectado'
    `;
    if (lojas.length === 0) return { criadas: 0 };
    for (const loja of lojas) {
      await this.sql`
        INSERT INTO notificacoes_admin (loja_id, mensagem)
        VALUES (${loja.id}, ${mensagem})
      `.catch(() => {});
    }
    return { criadas: lojas.length };
  }
}
