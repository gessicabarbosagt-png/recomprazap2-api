import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DATABASE_CLIENT } from '../database/database.module';
import axios from 'axios';

// Tipos das mensagens recebidas da 360dialog via webhook
interface WebhookPayload {
  messages?: WebhookMessage[];
}

interface WebhookMessage {
  from: string;       // Número do cliente (E.164 sem o +)
  id: string;         // ID da mensagem no WhatsApp
  type: string;       // 'text', 'interactive', etc.
  text?: { body: string };
  interactive?: {
    type: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
}

@Injectable()
export class WhatsappService {
  private readonly logger = new Logger(WhatsappService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
    private readonly config: ConfigService,
  ) {
    this.baseUrl = this.config.get<string>('DIALOG360_BASE_URL');
    this.apiKey  = this.config.get<string>('DIALOG360_API_KEY');
  }

  // ----------------------------------------------------------------
  // ENVIO DE MENSAGENS — chamado pelo worker de lembretes
  // ----------------------------------------------------------------

  // Envia a mensagem de lembrete de recompra para o cliente
  // Usa botões interativos: 1=Quero pedir | 2=Deixa pra depois | 3=Não quero mais
  async enviarLembrete(params: {
    telefone: string;
    clienteNome: string;
    produtoNome: string;
    quantidade?: number;
    unidade?: string;
    lembreteId: string;
  }) {
    const { telefone, clienteNome, produtoNome, quantidade, unidade, lembreteId } = params;

    const qtdTexto = quantidade
      ? ` (${quantidade}${unidade ? ' ' + unidade : ''})`
      : '';

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: telefone.replace('+', ''), // 360dialog não usa o "+"
      type: 'interactive',
      interactive: {
        type: 'button',
        body: {
          text: `Oi, ${clienteNome}! 👋\n\nJá está na hora de repor *${produtoNome}*${qtdTexto}. Posso te ajudar a pedir?`,
        },
        action: {
          buttons: [
            { type: 'reply', reply: { id: `pedir:${lembreteId}`, title: '✅ Quero pedir' } },
            { type: 'reply', reply: { id: `depois:${lembreteId}`, title: '⏰ Deixa pra depois' } },
            { type: 'reply', reply: { id: `sair:${lembreteId}`, title: '❌ Não preciso mais' } },
          ],
        },
      },
    };

    try {
      const response = await axios.post(
        `${this.baseUrl}/messages`,
        payload,
        { headers: { 'D360-API-KEY': this.apiKey, 'Content-Type': 'application/json' } },
      );

      // Registra a mensagem enviada no histórico
      await this.registrarMensagem({
        lojaId: null, // será preenchido pelo caller se necessário
        lembreteId,
        telefone,
        direcao: 'saida',
        conteudo: payload.interactive.body.text,
        whatsappMsgId: response.data?.messages?.[0]?.id,
      });

      return response.data;
    } catch (err) {
      this.logger.error('Erro ao enviar mensagem 360dialog', err?.response?.data);
      throw err;
    }
  }

  // ----------------------------------------------------------------
  // WEBHOOK — recebe respostas dos clientes
  // ----------------------------------------------------------------

  // Ponto de entrada do webhook da 360dialog
  // POST /api/v1/whatsapp/webhook
  async processarWebhook(payload: WebhookPayload) {
    if (!payload.messages?.length) return { ok: true };

    for (const msg of payload.messages) {
      await this.processarMensagem(msg);
    }

    return { ok: true };
  }

  private async processarMensagem(msg: WebhookMessage) {
    // Extrai o texto ou o ID do botão clicado
    const respostaId = msg.interactive?.button_reply?.id ?? msg.text?.body ?? '';

    this.logger.log(`Mensagem recebida de ${msg.from}: ${respostaId}`);

    // Salva no histórico independentemente do tipo de resposta
    await this.registrarMensagem({
      lojaId: null,
      lembreteId: null,
      telefone: '+' + msg.from,
      direcao: 'entrada',
      conteudo: msg.text?.body ?? msg.interactive?.button_reply?.title ?? '',
      whatsappMsgId: msg.id,
    });

    // Interpreta a resposta do botão: formato "acao:lembreteId"
    if (respostaId.includes(':')) {
      const [acao, lembreteId] = respostaId.split(':');
      await this.processarResposta(acao, lembreteId, msg.from);
    }
  }

  private async processarResposta(acao: string, lembreteId: string, telefone: string) {
    // Busca o lembrete pelo ID para saber a qual ciclo/loja pertence
    const [lembrete] = await this.sql`
      SELECT l.id, l.loja_id, l.ciclo_id,
             cr.cliente_id, cr.produto_id, cr.quantidade,
             p.nome AS produto_nome, c.nome AS cliente_nome
      FROM lembretes l
      JOIN ciclos_recompra cr ON cr.id = l.ciclo_id
      JOIN clientes c         ON c.id  = cr.cliente_id
      JOIN produtos p         ON p.id  = cr.produto_id
      WHERE l.id = ${lembreteId}
    `;

    if (!lembrete) {
      this.logger.warn(`Lembrete ${lembreteId} não encontrado para resposta`);
      return;
    }

    switch (acao) {
      case 'pedir':
        await this.tratarPedido(lembrete);
        break;
      case 'depois':
        await this.tratarDepois(lembrete);
        break;
      case 'sair':
        await this.tratarSaida(lembrete, telefone);
        break;
    }
  }

  // Cliente clicou "Quero pedir" → cria pedido pendente e atualiza lembrete
  private async tratarPedido(lembrete: any) {
    // Cria o pedido com status pendente (loja vai confirmar no painel)
    await this.sql`
      INSERT INTO pedidos (loja_id, lembrete_id, cliente_id, produto_id, quantidade, status)
      VALUES (
        ${lembrete.lojaId},
        ${lembrete.id},
        ${lembrete.clienteId},
        ${lembrete.produtoId},
        ${lembrete.quantidade ?? 1},
        'pendente'
      )
    `;

    // Marca o lembrete como respondido
    await this.sql`
      UPDATE lembretes SET status = 'respondido', updated_at = NOW()
      WHERE id = ${lembrete.id}
    `;

    this.logger.log(`Pedido criado a partir do lembrete ${lembrete.id}`);
  }

  // Cliente clicou "Deixa pra depois" → empurra proxima_notificacao +7 dias
  private async tratarDepois(lembrete: any) {
    await this.sql`
      UPDATE ciclos_recompra SET
        proxima_notificacao = NOW() + INTERVAL '7 days',
        updated_at = NOW()
      WHERE id = ${lembrete.cicloId}
    `;

    await this.sql`
      UPDATE lembretes SET status = 'respondido', updated_at = NOW()
      WHERE id = ${lembrete.id}
    `;
  }

  // Cliente clicou "Não preciso mais" → gera cupom de retenção e desativa o ciclo
  private async tratarSaida(lembrete: any, telefone: string) {
    // Gera um cupom de 10% para tentar reter o cliente
    const codigo = `RET-${Date.now().toString(36).toUpperCase()}`;
    await this.sql`
      INSERT INTO cupons (loja_id, cliente_id, codigo, desconto_pct, valido_ate)
      VALUES (
        ${lembrete.lojaId},
        ${lembrete.clienteId},
        ${codigo},
        10.00,
        CURRENT_DATE + INTERVAL '30 days'
      )
    `;

    // Desativa o ciclo
    await this.sql`
      UPDATE ciclos_recompra SET ativo = FALSE, updated_at = NOW()
      WHERE id = ${lembrete.cicloId}
    `;

    await this.sql`
      UPDATE lembretes SET status = 'respondido', updated_at = NOW()
      WHERE id = ${lembrete.id}
    `;

    this.logger.log(`Cupom de retenção ${codigo} gerado para o cliente do lembrete ${lembrete.id}`);
  }

  // ----------------------------------------------------------------
  // HISTÓRICO DE MENSAGENS
  // ----------------------------------------------------------------

  private async registrarMensagem(params: {
    lojaId: string | null;
    lembreteId: string | null;
    telefone: string;
    direcao: 'entrada' | 'saida';
    conteudo: string;
    whatsappMsgId?: string;
  }) {
    // Tenta encontrar o cliente pelo telefone (pode não ter loja_id no webhook)
    try {
      await this.sql`
        INSERT INTO mensagens_whatsapp
          (loja_id, lembrete_id, cliente_id, direcao, conteudo, whatsapp_msg_id)
        SELECT
          cr.loja_id,
          ${params.lembreteId},
          c.id,
          ${params.direcao},
          ${params.conteudo},
          ${params.whatsappMsgId ?? null}
        FROM clientes c
        JOIN ciclos_recompra cr ON cr.cliente_id = c.id
        WHERE c.telefone = ${params.telefone}
        LIMIT 1
      `;
    } catch (err) {
      // Não quebra o fluxo se o registro de histórico falhar
      this.logger.warn('Não foi possível registrar mensagem no histórico', err);
    }
  }

  // Lista o histórico de mensagens de uma loja
  async listarMensagens(lojaId: string, clienteId?: string) {
    return this.sql`
      SELECT
        m.id, m.direcao, m.conteudo, m.created_at,
        c.nome AS cliente_nome, c.telefone
      FROM mensagens_whatsapp m
      JOIN clientes c ON c.id = m.cliente_id
      WHERE m.loja_id = ${lojaId}
        ${clienteId ? this.sql`AND m.cliente_id = ${clienteId}` : this.sql``}
      ORDER BY m.created_at DESC
      LIMIT 100
    `;
  }
}
