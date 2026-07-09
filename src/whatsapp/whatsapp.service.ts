import { Injectable, Inject, Logger } from '@nestjs/common';
import { DATABASE_CLIENT } from '../database/database.module';
import { WhatsappBaileysService } from './whatsapp-baileys.service';

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);

  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
    private readonly baileysService: WhatsappBaileysService,
  ) {}

  // Chamado pelo worker de lembretes e pelo CiclosService — delega ao Baileys
  async enviarLembrete(params: {
    telefone: string;
    clienteNome: string;
    produtoNome: string;
    quantidade?: number;
    unidade?: string;
    lembreteId: string;
    lojaId: string;
  }) {
    return this.baileysService.enviarLembrete(params);
  }

  // Envia mensagem avulsa (ex: resposta manual do painel)
  async enviarMensagem(lojaId: string, telefone: string, conteudo: string) {
    const msgId = await this.baileysService.enviarMensagem(telefone, conteudo);

    try {
      await this.sql`
        INSERT INTO mensagens_whatsapp
          (loja_id, cliente_id, direcao, conteudo, tipo, origem, whatsapp_message_id)
        SELECT
          ${lojaId}, c.id, 'enviada'::mensagem_direcao, ${conteudo}, 'manual', 'painel',
          ${msgId || null}
        FROM clientes c
        WHERE c.telefone = ${telefone} AND c.loja_id = ${lojaId}
        LIMIT 1
        ON CONFLICT (loja_id, whatsapp_message_id)
          WHERE whatsapp_message_id IS NOT NULL
          DO NOTHING
      `;
    } catch (err: any) {
      this.logger.warn('Erro ao registrar mensagem manual no histórico', err?.message);
    }
  }

  // Lista o histórico de mensagens de uma loja (exclui conversas deletadas e msgs de protocolo)
  async listarMensagens(lojaId: string) {
    return this.sql`
      SELECT
        m.id,
        m.direcao,
        m.conteudo,
        m.tipo,
        m.created_at   AS "criadoEm",
        c.id           AS "clienteId",
        c.nome         AS "clienteNome",
        c.telefone,
        c.origem_lead  AS "origemLead"
      FROM mensagens_whatsapp m
      JOIN clientes c ON c.id = m.cliente_id
      WHERE m.loja_id    = ${lojaId}
        AND m.deleted_at IS NULL
      ORDER BY m.created_at ASC
      LIMIT 500
    `;
  }

  // Soft-delete de todas as mensagens de uma conversa
  async excluirConversa(lojaId: string, clienteId: string) {
    await this.sql`
      UPDATE mensagens_whatsapp
      SET deleted_at = NOW()
      WHERE loja_id   = ${lojaId}
        AND cliente_id = ${clienteId}
        AND deleted_at IS NULL
    `;
  }
}
