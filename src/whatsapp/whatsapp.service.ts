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

  // Chamado pelo worker de lembretes — delega ao Baileys
  async enviarLembrete(params: {
    telefone: string;
    clienteNome: string;
    produtoNome: string;
    quantidade?: number;
    unidade?: string;
    lembreteId: string;
  }) {
    return this.baileysService.enviarLembrete(params);
  }

  // Envia mensagem avulsa (ex: resposta manual do painel)
  async enviarMensagem(lojaId: string, telefone: string, conteudo: string) {
    await this.baileysService.enviarMensagem(telefone, conteudo);

    try {
      await this.sql`
        INSERT INTO mensagens_whatsapp
          (loja_id, cliente_id, direcao, conteudo, tipo)
        SELECT ${lojaId}, c.id, 'saida', ${conteudo}, 'manual'
        FROM clientes c
        WHERE c.telefone = ${telefone} AND c.loja_id = ${lojaId}
        LIMIT 1
        ON CONFLICT DO NOTHING
      `;
    } catch (err) {
      this.logger.warn('Erro ao registrar mensagem manual no histórico', err?.message);
    }
  }

  // Lista o histórico de mensagens de uma loja agrupando por telefone
  async listarMensagens(lojaId: string) {
    return this.sql`
      SELECT
        m.id,
        m.direcao,
        m.conteudo,
        m.tipo,
        m.created_at AS "criadoEm",
        c.nome       AS "clienteNome",
        c.telefone
      FROM mensagens_whatsapp m
      JOIN clientes c ON c.id = m.cliente_id
      WHERE m.loja_id = ${lojaId}
      ORDER BY m.created_at ASC
      LIMIT 500
    `;
  }
}
