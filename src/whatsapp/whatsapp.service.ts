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
    clienteWhatsappNome?: string | null;
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
        m.created_at          AS "criadoEm",
        m.lida_em IS NOT NULL AS "lida",
        c.id                  AS "clienteId",
        c.nome                AS "clienteNome",
        c.whatsapp_nome       AS "clienteWhatsappNome",
        c.telefone,
        c.origem_lead         AS "origemLead"
      FROM mensagens_whatsapp m
      JOIN clientes c ON c.id = m.cliente_id
      WHERE m.loja_id    = ${lojaId}
        AND m.deleted_at IS NULL
      ORDER BY m.created_at ASC
      LIMIT 500
    `;
  }

  // Marca todas as mensagens recebidas de uma conversa como lidas
  async marcarConversaLida(lojaId: string, clienteId: string) {
    // Busca IDs das mensagens não lidas antes de marcar (necessário para Baileys readMessages)
    const naoLidas = await this.sql`
      SELECT m.whatsapp_message_id, c.telefone
      FROM mensagens_whatsapp m
      JOIN clientes c ON c.id = m.cliente_id
      WHERE m.loja_id    = ${lojaId}
        AND m.cliente_id = ${clienteId}
        AND m.direcao    = 'recebida'
        AND m.lida_em    IS NULL
        AND m.deleted_at IS NULL
        AND m.whatsapp_message_id IS NOT NULL
      LIMIT 50
    `;

    await this.sql`
      UPDATE mensagens_whatsapp
      SET lida_em = NOW()
      WHERE loja_id    = ${lojaId}
        AND cliente_id = ${clienteId}
        AND direcao    = 'recebida'
        AND lida_em    IS NULL
        AND deleted_at IS NULL
    `;

    // Confirmação de leitura no WhatsApp (se configurado pela loja)
    if (naoLidas.length > 0) {
      const [loja] = await this.sql`SELECT confirmar_leitura_wa FROM lojas WHERE id = ${lojaId}`;
      if (loja?.confirmarLeituraWa) {
        const telefone: string = naoLidas[0].telefone;
        const messageIds: string[] = naoLidas.map((m: any) => m.whatsappMessageId).filter(Boolean);
        await this.baileysService.marcarLidaNoWhatsApp(telefone, messageIds);
      }
    }
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
