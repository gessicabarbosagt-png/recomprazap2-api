import { Injectable, Logger, Inject, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DATABASE_CLIENT } from '../database/database.module';
import axios from 'axios';
import { createHmac } from 'crypto';
import { Resend } from 'resend';
import { EmailService } from '../email/email.service';

@Injectable()
export class PagamentosService {
  private readonly logger = new Logger(PagamentosService.name);
  private readonly mpApiBase = 'https://api.mercadopago.com';

  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
    private readonly config: ConfigService,
    private readonly emailService: EmailService,
  ) {}

  private get accessToken(): string {
    return this.config.getOrThrow<string>('MP_ACCESS_TOKEN');
  }

  private get webhookSecret(): string {
    return this.config.getOrThrow<string>('MP_WEBHOOK_SECRET');
  }

  private get frontendUrl(): string {
    return this.config.get<string>('FRONTEND_URL') ?? 'https://recomprazap.com.br';
  }

  private mpHeaders() {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  // ── Status do plano ────────────────────────────────────────────────

  async buscarStatusPlano(lojaId: string) {
    const [loja] = await this.sql`
      SELECT
        status_assinatura, valor_mensalidade, proximo_vencimento,
        mp_payment_method, mp_card_last_four,
        inadimplente_desde, ativa
      FROM lojas WHERE id = ${lojaId} AND deleted_at IS NULL
    `;
    return loja;
  }

  // ── Assinatura via cartão ──────────────────────────────────────────

  async criarAssinaturaCartao(lojaId: string, dto: {
    cardToken: string;
    payerEmail: string;
    lastFour?: string;
  }) {
    const [loja] = await this.sql`
      SELECT valor_mensalidade, mp_subscription_id FROM lojas
      WHERE id = ${lojaId} AND deleted_at IS NULL
    `;
    if (!loja) throw new BadRequestException('Loja não encontrada');
    if (!loja.valorMensalidade || Number(loja.valorMensalidade) <= 0) {
      throw new BadRequestException('Valor da mensalidade não configurado — contate o suporte');
    }

    // Cancela assinatura anterior se existir
    if (loja.mpSubscriptionId) {
      await this.cancelarPreapprovalNoMP(loja.mpSubscriptionId).catch(() => {});
    }

    const startDate = new Date();
    startDate.setHours(startDate.getHours() + 1);

    const { data } = await axios.post(
      `${this.mpApiBase}/preapproval`,
      {
        reason: 'Mensalidade RecompraZap',
        auto_recurring: {
          frequency: 1,
          frequency_type: 'months',
          start_date: startDate.toISOString(),
          transaction_amount: Number(loja.valorMensalidade),
          currency_id: 'BRL',
        },
        card_token_id: dto.cardToken,
        payer_email: dto.payerEmail,
        status: 'authorized',
        back_url: `${this.frontendUrl}/plano`,
      },
      { headers: this.mpHeaders() },
    );

    await this.sql`
      UPDATE lojas SET
        mp_subscription_id = ${data.id},
        mp_payment_method  = 'card',
        mp_card_last_four  = ${dto.lastFour ?? null},
        updated_at         = NOW()
      WHERE id = ${lojaId}
    `;

    this.logger.log(`[MP] assinatura por cartão criada: preapproval_id=${data.id} loja=${lojaId}`);
    return { subscriptionId: data.id };
  }

  // ── Trocar cartão ──────────────────────────────────────────────────

  async trocarCartao(lojaId: string, dto: {
    cardToken: string;
    payerEmail: string;
    lastFour?: string;
  }) {
    const [loja] = await this.sql`
      SELECT mp_subscription_id FROM lojas WHERE id = ${lojaId} AND deleted_at IS NULL
    `;
    if (!loja) throw new BadRequestException('Loja não encontrada');

    if (loja.mpSubscriptionId) {
      await axios.put(
        `${this.mpApiBase}/preapproval/${loja.mpSubscriptionId}`,
        { card_token_id: dto.cardToken },
        { headers: this.mpHeaders() },
      );
      await this.sql`
        UPDATE lojas SET mp_card_last_four = ${dto.lastFour ?? null}, updated_at = NOW()
        WHERE id = ${lojaId}
      `;
      this.logger.log(`[MP] cartão trocado: preapproval_id=${loja.mpSubscriptionId} loja=${lojaId}`);
    } else {
      await this.criarAssinaturaCartao(lojaId, dto);
    }
  }

  // ── Cancelar assinatura ────────────────────────────────────────────

  async cancelarAssinatura(lojaId: string) {
    const [loja] = await this.sql`
      SELECT mp_subscription_id FROM lojas WHERE id = ${lojaId} AND deleted_at IS NULL
    `;
    if (loja?.mpSubscriptionId) {
      await this.cancelarPreapprovalNoMP(loja.mpSubscriptionId).catch((e: any) => {
        this.logger.warn(`[MP] erro ao cancelar preapproval ${loja.mpSubscriptionId}: ${e?.message}`);
      });
    }
    await this.sql`
      UPDATE lojas SET
        mp_subscription_id = NULL,
        mp_payment_method  = NULL,
        mp_card_last_four  = NULL,
        updated_at         = NOW()
      WHERE id = ${lojaId}
    `;
  }

  private async cancelarPreapprovalNoMP(subscriptionId: string) {
    await axios.put(
      `${this.mpApiBase}/preapproval/${subscriptionId}`,
      { status: 'cancelled' },
      { headers: this.mpHeaders() },
    );
  }

  // ── Pix por ciclo ─────────────────────────────────────────────────

  async gerarPixCiclo(lojaId: string) {
    const [loja] = await this.sql`
      SELECT valor_mensalidade, email FROM lojas WHERE id = ${lojaId} AND deleted_at IS NULL
    `;
    if (!loja) throw new BadRequestException('Loja não encontrada');
    if (!loja.valorMensalidade || Number(loja.valorMensalidade) <= 0) {
      throw new BadRequestException('Valor da mensalidade não configurado — contate o suporte');
    }

    // Retorna Pix pendente válido se já existe
    const [pixAtivo] = await this.sql`
      SELECT id, mp_payment_id, pix_qr_code, pix_qr_code_base64, pix_expira_em, valor, criado_em
      FROM pagamentos
      WHERE loja_id = ${lojaId}
        AND tipo = 'pix'
        AND status = 'pendente'
        AND pix_expira_em > NOW()
      ORDER BY criado_em DESC
      LIMIT 1
    `;
    if (pixAtivo) return pixAtivo;

    const expiracao = new Date();
    expiracao.setDate(expiracao.getDate() + 3);

    const webhookUrl = this.config.get<string>('MP_WEBHOOK_URL');
    const payload: any = {
      transaction_amount: Number(loja.valorMensalidade),
      description: 'Mensalidade RecompraZap',
      payment_method_id: 'pix',
      payer: { email: loja.email },
      date_of_expiration: expiracao.toISOString(),
      external_reference: lojaId,
    };
    if (webhookUrl) payload.notification_url = webhookUrl;

    const { data } = await axios.post(
      `${this.mpApiBase}/v1/payments`,
      payload,
      { headers: this.mpHeaders() },
    );

    const txData = data.point_of_interaction?.transaction_data;
    const [registro] = await this.sql`
      INSERT INTO pagamentos (loja_id, mp_payment_id, tipo, valor, status, descricao, pix_qr_code, pix_qr_code_base64, pix_expira_em)
      VALUES (
        ${lojaId},
        ${String(data.id)},
        'pix',
        ${Number(loja.valorMensalidade)},
        'pendente',
        'Mensalidade via Pix',
        ${txData?.qr_code ?? null},
        ${txData?.qr_code_base64 ?? null},
        ${expiracao.toISOString()}
      )
      RETURNING id, mp_payment_id, pix_qr_code, pix_qr_code_base64, pix_expira_em, valor, criado_em
    `;

    this.logger.log(`[MP] pix gerado: payment_id=${data.id} loja=${lojaId} valor=${loja.valorMensalidade}`);
    return registro;
  }

  // ── Histórico de pagamentos ────────────────────────────────────────

  async listarPagamentos(lojaId: string) {
    return this.sql`
      SELECT id, tipo, valor, status, descricao, mp_payment_id,
             pix_qr_code, pix_qr_code_base64, pix_expira_em, criado_em
      FROM pagamentos
      WHERE loja_id = ${lojaId}
      ORDER BY criado_em DESC
      LIMIT 50
    `;
  }

  async listarPagamentosAdmin(lojaId: string) {
    return this.sql`
      SELECT id, tipo, valor, status, descricao, mp_payment_id, criado_em
      FROM pagamentos
      WHERE loja_id = ${lojaId}
      ORDER BY criado_em DESC
      LIMIT 50
    `;
  }

  // ── Webhook: validação HMAC ────────────────────────────────────────

  validarAssinaturaWebhook(
    xSignature: string,
    xRequestId: string,
    dataId: string,
    ts: string,
  ): boolean {
    const message = `id:${dataId};request-id:${xRequestId};ts:${ts};`;
    const expected = createHmac('sha256', this.webhookSecret).update(message).digest('hex');
    const v1Match = xSignature.match(/v1=([a-f0-9]+)/);
    if (!v1Match) return false;
    return expected === v1Match[1];
  }

  // ── Webhook: processamento de eventos ─────────────────────────────

  async processarWebhook(body: any) {
    const tipo    = body?.type as string;
    const action  = body?.action as string;
    const dataId  = String(body?.data?.id ?? '');

    this.logger.log(`[MP Webhook] tipo=${tipo} action=${action} dataId=${dataId}`);

    try {
      if (tipo === 'subscription_authorized_payment') {
        await this.processarPagamentoAssinatura(dataId);
      } else if (tipo === 'payment') {
        await this.processarPagamentoPix(dataId);
      } else if (tipo === 'subscription_preapproval') {
        await this.processarStatusPreapproval(dataId);
      }
    } catch (e: any) {
      this.logger.error(`[MP Webhook] erro ao processar evento: ${e?.message}`);
    }
  }

  private async processarPagamentoAssinatura(authorizedPaymentId: string) {
    const { data } = await axios.get(
      `${this.mpApiBase}/v1/subscription_authorized_payments/${authorizedPaymentId}`,
      { headers: this.mpHeaders() },
    ).catch(() => ({ data: null as any }));
    if (!data) return;

    const preapprovalId = String(data.preapproval_id ?? '');
    const status        = data.status as string; // 'processed' | 'recycling' | 'cancelled'
    const valor         = Number(data.transaction_amount ?? 0);
    const mpPaymentId   = String(data.id);

    const [loja] = await this.sql`
      SELECT id, nome, email, status_assinatura FROM lojas
      WHERE mp_subscription_id = ${preapprovalId} AND deleted_at IS NULL
    `;
    if (!loja) {
      this.logger.warn(`[MP Webhook] preapproval ${preapprovalId} não encontrado`);
      return;
    }

    if (status === 'processed') {
      await this.upsertPagamento(loja.id, mpPaymentId, 'card', valor, 'aprovado', 'Mensalidade via cartão');
      await this.sql`
        UPDATE lojas SET
          status_assinatura  = 'ativa',
          inadimplente_desde = NULL,
          proximo_vencimento = (CURRENT_DATE + INTERVAL '1 month')::DATE,
          updated_at         = NOW()
        WHERE id = ${loja.id}
      `;
      this.logger.log(`[MP Webhook] pagamento aprovado: loja=${loja.id}`);

    } else if (status === 'recycling') {
      await this.upsertPagamento(loja.id, mpPaymentId, 'card', valor, 'recusado', 'Mensalidade via cartão — recusada');
      if (loja.statusAssinatura !== 'inadimplente') {
        await this.sql`
          UPDATE lojas SET
            status_assinatura  = 'inadimplente',
            inadimplente_desde = COALESCE(inadimplente_desde, NOW()),
            updated_at         = NOW()
          WHERE id = ${loja.id}
        `;
        await this.criarNotificacaoInadimplente(loja.id);
        await this.enviarEmailInadimplente(loja.email, loja.id);
        this.emailService.enviarAlertaPagamentoRecusado(loja.id, loja.nome ?? loja.id, loja.email).catch(() => {});
        this.logger.log(`[MP Webhook] loja ${loja.id} marcada inadimplente`);
      }
    }
  }

  private async processarPagamentoPix(paymentId: string) {
    const { data } = await axios.get(
      `${this.mpApiBase}/v1/payments/${paymentId}`,
      { headers: this.mpHeaders() },
    ).catch(() => ({ data: null as any }));
    if (!data) return;
    if (data.payment_method_id !== 'pix') return;

    const lojaId = data.external_reference as string;
    if (!lojaId) return;

    const status = data.status as string; // 'approved' | 'pending' | 'rejected' | 'cancelled' | 'expired'
    const mpId   = String(data.id);

    if (status === 'approved') {
      await this.sql`
        UPDATE pagamentos SET status = 'aprovado', atualizado_em = NOW()
        WHERE mp_payment_id = ${mpId}
      `.catch(() => {});
      await this.sql`
        UPDATE lojas SET
          status_assinatura  = 'ativa',
          inadimplente_desde = NULL,
          proximo_vencimento = (CURRENT_DATE + INTERVAL '1 month')::DATE,
          updated_at         = NOW()
        WHERE id = ${lojaId}
      `;
      this.logger.log(`[MP Webhook] pix aprovado: loja=${lojaId} payment=${mpId}`);

    } else if (status === 'rejected' || status === 'cancelled' || status === 'expired') {
      const novoStatus = status === 'expired' ? 'cancelado' : 'recusado';
      await this.sql`
        UPDATE pagamentos SET status = ${novoStatus}, atualizado_em = NOW()
        WHERE mp_payment_id = ${mpId}
      `.catch(() => {});
    }
  }

  private async processarStatusPreapproval(preapprovalId: string) {
    const { data } = await axios.get(
      `${this.mpApiBase}/preapproval/${preapprovalId}`,
      { headers: this.mpHeaders() },
    ).catch(() => ({ data: null as any }));
    if (!data) return;

    if (data.status === 'cancelled') {
      const [loja] = await this.sql`
        SELECT id FROM lojas WHERE mp_subscription_id = ${preapprovalId} AND deleted_at IS NULL
      `;
      if (loja) {
        await this.sql`
          UPDATE lojas SET
            mp_subscription_id = NULL,
            mp_payment_method  = NULL,
            ativa              = false,
            updated_at         = NOW()
          WHERE id = ${loja.id}
        `;
        this.logger.log(`[MP Webhook] assinatura cancelada pelo MP: loja=${loja.id}`);
      }
    }
  }

  // ── Helpers internos ───────────────────────────────────────────────

  private async upsertPagamento(
    lojaId: string, mpPaymentId: string, tipo: string,
    valor: number, status: string, descricao: string,
  ) {
    await this.sql`
      INSERT INTO pagamentos (loja_id, mp_payment_id, tipo, valor, status, descricao)
      VALUES (${lojaId}, ${mpPaymentId}, ${tipo}, ${valor}, ${status}, ${descricao})
      ON CONFLICT (mp_payment_id) DO UPDATE
        SET status = ${status}, atualizado_em = NOW()
    `.catch(() => {});
  }

  private async criarNotificacaoInadimplente(lojaId: string) {
    await this.sql`
      INSERT INTO notificacoes_admin (loja_id, mensagem)
      VALUES (${lojaId}, 'Seu pagamento foi recusado. Acesse "Meu Plano" e atualize seu método de pagamento para evitar a suspensão do serviço.')
    `.catch(() => {});
  }

  private async enviarEmailInadimplente(email: string, lojaId: string) {
    const apiKey = this.config.get<string>('RESEND_API_KEY');
    if (!apiKey) return;
    try {
      const resend = new Resend(apiKey);
      const fromAddress = this.config.get<string>('RESEND_FROM') ?? 'noreply@recomprazap.com.br';
      await resend.emails.send({
        from: fromAddress,
        to: [email],
        subject: 'Pagamento recusado — Regularize seu plano RecompraZap',
        html: `<p>Olá,</p>
<p>Identificamos que o pagamento da sua mensalidade foi recusado.</p>
<p>Para evitar a suspensão do serviço, acesse o painel e atualize seu método de pagamento em <strong>Meu Plano</strong>.</p>
<p>Após 5 dias sem regularização, o acesso à plataforma poderá ser suspenso.</p>
<p>Equipe RecompraZap</p>`,
      });
    } catch (e: any) {
      this.logger.warn(`[Email] erro ao enviar email inadimplente: ${e?.message}`);
    }
  }

  // ── Atualiza valor da assinatura no MP (chamado ao fazer upgrade) ───

  async atualizarValorPreapproval(lojaId: string, novoValor: number) {
    const [loja] = await this.sql`
      SELECT mp_subscription_id FROM lojas WHERE id = ${lojaId} AND deleted_at IS NULL
    `;
    if (!loja?.mpSubscriptionId) return;
    try {
      await axios.put(
        `${this.mpApiBase}/preapproval/${loja.mpSubscriptionId}`,
        { auto_recurring: { transaction_amount: novoValor } },
        { headers: this.mpHeaders() },
      );
      this.logger.log(`[MP] preapproval ${loja.mpSubscriptionId} valor atualizado para ${novoValor}`);
    } catch (e: any) {
      this.logger.warn(`[MP] erro ao atualizar valor preapproval ${loja.mpSubscriptionId}: ${e?.message}`);
    }
  }

  // ── Aviso diário (chamado pelo cron) ───────────────────────────────

  async avisarInadimplentesAtivos() {
    const inadimplentes = await this.sql`
      SELECT id FROM lojas
      WHERE status_assinatura = 'inadimplente'
        AND ativa = TRUE
        AND deleted_at IS NULL
        AND inadimplente_desde > NOW() - INTERVAL '5 days'
    `;
    for (const loja of inadimplentes) {
      await this.sql`
        INSERT INTO notificacoes_admin (loja_id, mensagem)
        VALUES (${loja.id}, 'Aviso: seu pagamento ainda está pendente. Regularize em "Meu Plano" para evitar a suspensão.')
      `.catch(() => {});
    }
    return inadimplentes.length;
  }

  async suspenderInadimplentesVencidos() {
    const para_suspender = await this.sql`
      SELECT id FROM lojas
      WHERE status_assinatura = 'inadimplente'
        AND ativa = TRUE
        AND deleted_at IS NULL
        AND inadimplente_desde <= NOW() - INTERVAL '5 days'
    `;
    for (const loja of para_suspender) {
      await this.sql`
        UPDATE lojas SET ativa = false, updated_at = NOW() WHERE id = ${loja.id}
      `;
      await this.sql`
        INSERT INTO notificacoes_admin (loja_id, mensagem)
        VALUES (${loja.id}, 'Seu acesso foi suspenso por inadimplência. Entre em contato com o suporte para regularizar.')
      `.catch(() => {});
      this.logger.log(`[Suspensão] loja ${loja.id} suspensa por inadimplência de 5+ dias`);
    }
    return para_suspender.length;
  }
}
