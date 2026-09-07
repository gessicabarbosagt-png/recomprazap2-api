import { Injectable, Logger, Inject, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DATABASE_CLIENT } from '../database/database.module';
import Stripe from 'stripe';
import { Resend } from 'resend';
import { EmailService } from '../email/email.service';

@Injectable()
export class PagamentosService {
  private readonly logger = new Logger(PagamentosService.name);
  private readonly stripe: Stripe;

  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
    private readonly config: ConfigService,
    private readonly emailService: EmailService,
  ) {
    this.stripe = new Stripe(config.getOrThrow<string>('STRIPE_SECRET_KEY'));
  }

  private get webhookSecret(): string {
    return this.config.getOrThrow<string>('STRIPE_WEBHOOK_SECRET');
  }

  private get frontendUrl(): string {
    return this.config.get<string>('FRONTEND_URL') ?? 'https://app.recomprazap.com.br';
  }

  // ── Status do plano ────────────────────────────────────────────────

  async buscarStatusPlano(lojaId: string) {
    const [loja] = await this.sql`
      SELECT
        status_assinatura, valor_mensalidade, proximo_vencimento,
        stripe_customer_id, stripe_subscription_id,
        inadimplente_desde, ativa
      FROM lojas WHERE id = ${lojaId} AND deleted_at IS NULL
    `;
    return loja;
  }

  // ── Stripe Checkout Session ────────────────────────────────────────

  async criarCheckoutSession(lojaId: string) {
    const [loja] = await this.sql`
      SELECT id, email, plano_slug, stripe_customer_id FROM lojas
      WHERE id = ${lojaId} AND deleted_at IS NULL
    `;
    if (!loja) throw new BadRequestException('Loja não encontrada');

    const [plano] = loja.planoSlug
      ? await this.sql`
          SELECT stripe_price_id FROM planos_catalogo WHERE slug = ${loja.planoSlug}
        `
      : [null];

    if (!plano?.stripePriceId) {
      throw new BadRequestException(
        'Price ID do Stripe não configurado para este plano. Configure stripe_price_id em planos_catalogo ou contate o suporte.',
      );
    }

    const params: Stripe.Checkout.SessionCreateParams = {
      mode: 'subscription',
      line_items: [{ price: plano.stripePriceId, quantity: 1 }],
      success_url: `${this.frontendUrl}/plano?sucesso=true`,
      cancel_url:  `${this.frontendUrl}/plano?cancelado=true`,
      metadata:          { lojaId },
      subscription_data: { metadata: { lojaId } },
    };

    if (loja.stripeCustomerId) {
      params.customer = loja.stripeCustomerId;
    } else {
      params.customer_email = loja.email;
    }

    const session = await this.stripe.checkout.sessions.create(params);
    this.logger.log(`[Stripe] checkout session criada: ${session.id} loja=${lojaId}`);
    return { url: session.url };
  }

  // ── Webhook Stripe ─────────────────────────────────────────────────

  construirEventoStripe(rawBody: Buffer, signature: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
  }

  async processarWebhookStripe(event: Stripe.Event) {
    this.logger.log(`[Stripe Webhook] tipo=${event.type} id=${event.id}`);

    try {
      if (event.type === 'checkout.session.completed') {
        await this.processarCheckoutCompletado(event.data.object as Stripe.Checkout.Session);
      } else if (event.type === 'invoice.payment_failed') {
        await this.processarPagamentoFalhou(event.data.object as Stripe.Invoice);
      }
    } catch (e: any) {
      this.logger.error(`[Stripe Webhook] erro ao processar ${event.type}: ${e?.message}`);
    }
  }

  private async processarCheckoutCompletado(session: Stripe.Checkout.Session) {
    const lojaId = session.metadata?.lojaId;
    if (!lojaId) {
      this.logger.warn('[Stripe Webhook] checkout.session.completed sem lojaId no metadata');
      return;
    }

    const subscriptionId = session.subscription as string;
    const customerId     = session.customer as string;
    const valorCentavos  = session.amount_total ?? 0;

    await this.sql`
      UPDATE lojas SET
        stripe_customer_id     = ${customerId},
        stripe_subscription_id = ${subscriptionId},
        status_assinatura      = 'ativa',
        inadimplente_desde     = NULL,
        ativa                  = TRUE,
        proximo_vencimento     = (CURRENT_DATE + INTERVAL '1 month')::DATE,
        updated_at             = NOW()
      WHERE id = ${lojaId}
    `;

    await this.upsertPagamento(
      lojaId, session.id, 'card',
      valorCentavos / 100,
      'aprovado', 'Assinatura Stripe',
    );

    this.logger.log(`[Stripe Webhook] checkout.session.completed: loja=${lojaId} sub=${subscriptionId}`);
  }

  private async processarPagamentoFalhou(invoice: Stripe.Invoice) {
    const customerId = invoice.customer as string;

    const [loja] = await this.sql`
      SELECT id, nome, email, status_assinatura FROM lojas
      WHERE stripe_customer_id = ${customerId} AND deleted_at IS NULL
    `;
    if (!loja) {
      this.logger.warn(`[Stripe Webhook] invoice.payment_failed: customer ${customerId} não encontrado`);
      return;
    }

    const valorCentavos = (invoice as any).amount_due ?? 0;
    await this.upsertPagamento(
      loja.id, invoice.id, 'card',
      valorCentavos / 100,
      'recusado', 'Mensalidade Stripe — falhou',
    );

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
      this.logger.log(`[Stripe Webhook] loja ${loja.id} marcada inadimplente`);
    }
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

  // ── Helpers internos ───────────────────────────────────────────────

  private async upsertPagamento(
    lojaId: string, paymentId: string, tipo: string,
    valor: number, status: string, descricao: string,
  ) {
    await this.sql`
      INSERT INTO pagamentos (loja_id, mp_payment_id, tipo, valor, status, descricao)
      VALUES (${lojaId}, ${paymentId}, ${tipo}, ${valor}, ${status}, ${descricao})
      ON CONFLICT (mp_payment_id) DO UPDATE
        SET status = ${status}, atualizado_em = NOW()
    `.catch(() => {});
  }

  private async criarNotificacaoInadimplente(lojaId: string) {
    await this.sql`
      INSERT INTO notificacoes_admin (loja_id, mensagem)
      VALUES (${lojaId}, 'Seu pagamento foi recusado. Acesse "Meu Plano" e regularize sua assinatura para evitar a suspensão do serviço.')
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
<p>Para evitar a suspensão do serviço, acesse o painel e regularize sua assinatura em <strong>Meu Plano</strong>.</p>
<p>Após 5 dias sem regularização, o acesso à plataforma poderá ser suspenso.</p>
<p>Equipe RecompraZap</p>`,
      });
    } catch (e: any) {
      this.logger.warn(`[Email] erro ao enviar email inadimplente: ${e?.message}`);
    }
  }

  // ── Atualiza assinatura Stripe ao fazer upgrade de plano ──────────

  async atualizarAssinaturaStripe(lojaId: string, novoPlanoSlug: string) {
    const [loja] = await this.sql`
      SELECT stripe_subscription_id FROM lojas WHERE id = ${lojaId} AND deleted_at IS NULL
    `;
    if (!loja?.stripeSubscriptionId) return;

    const [plano] = await this.sql`
      SELECT stripe_price_id FROM planos_catalogo WHERE slug = ${novoPlanoSlug}
    `;
    if (!plano?.stripePriceId) return;

    try {
      const subscription = await this.stripe.subscriptions.retrieve(loja.stripeSubscriptionId);
      const itemId = subscription.items.data[0]?.id;
      if (!itemId) return;

      await this.stripe.subscriptions.update(loja.stripeSubscriptionId, {
        items: [{ id: itemId, price: plano.stripePriceId }],
        proration_behavior: 'create_prorations',
      });
      this.logger.log(`[Stripe] assinatura ${loja.stripeSubscriptionId} atualizada para plano ${novoPlanoSlug}`);
    } catch (e: any) {
      this.logger.warn(`[Stripe] erro ao atualizar assinatura ${loja.stripeSubscriptionId}: ${e?.message}`);
    }
  }

  // ── Aviso diário / suspensão (chamados pelo cron) ─────────────────

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
