import { Injectable, Logger, Inject } from '@nestjs/common';
import { OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DATABASE_CLIENT } from '../database/database.module';
import { PagamentosService } from '../pagamentos/pagamentos.service';
import { PlanosService } from '../planos/planos.service';
import { EmailService } from '../email/email.service';
import {
  FILA_LEMBRETES,
  FILA_RETRY,
  JOB_ENVIAR_LEMBRETE,
  JOB_VERIFICAR_RESPOSTA,
  JOB_RETRY_LEMBRETE,
} from './worker.constants';

@Injectable()
export class AgendadorService implements OnApplicationBootstrap {
  private readonly logger = new Logger(AgendadorService.name);

  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
    @InjectQueue(FILA_LEMBRETES) private readonly filaLembretes: Queue,
    @InjectQueue(FILA_RETRY) private readonly filaRetry: Queue,
    private readonly pagamentosService: PagamentosService,
    private readonly planosService: PlanosService,
    private readonly emailService: EmailService,
  ) {}

  // Cancela lembretes presos como 'agendado' há mais de 4 horas.
  // Esses lembretes ficaram orphãos porque o Bull esgotou retries sem
  // @OnQueueFailed existir (27/07 outage). CRON 1 bloqueava nesses registros.
  async onApplicationBootstrap() {
    const result = await this.sql`
      UPDATE lembretes SET status = 'cancelado', updated_at = NOW()
      WHERE status = 'agendado'
        AND created_at < NOW() - INTERVAL '4 hours'
    `;
    if (result.count > 0) {
      this.logger.log(`Bootstrap: ${result.count} lembrete(s) presos cancelados (outage 27/07)`);
    }
  }

  // ----------------------------------------------------------------
  // CRON 1 — Roda a cada 5 minutos
  // Busca ciclos cujo proxima_notificacao já venceu e ainda não tem
  // lembrete 'agendado' ou 'enviado' em aberto.
  // ----------------------------------------------------------------
  @Cron(CronExpression.EVERY_5_MINUTES)
  async varrerCiclosVencidos() {
    this.logger.log('🔍 Varrendo ciclos com notificação vencida...');

    // A query só retorna ciclos que:
    //   - estão ativos e não deletados
    //   - têm proxima_notificacao no passado (já é hora de notificar)
    //   - não têm nenhum lembrete 'agendado' ou 'enviado' em aberto
    //     (evita duplicar notificação se o cron rodar duas vezes antes do job executar)
    const ciclos = await this.sql`
      SELECT
        cr.id          AS ciclo_id,
        cr.loja_id,
        cr.proxima_notificacao,
        l.retry_automatico,
        l.horas_para_retry,
        l.horario_abertura,
        l.horario_fechamento,
        l.dias_funcionamento,
        c.nome         AS cliente_nome,
        c.whatsapp_nome AS whatsapp_nome,
        c.telefone     AS cliente_telefone,
        c.consentimento_whatsapp,
        p.nome         AS produto_nome,
        p.unidade      AS produto_unidade,
        cr.quantidade
      FROM ciclos_recompra cr
      JOIN lojas    l ON l.id = cr.loja_id
      JOIN clientes c ON c.id = cr.cliente_id
      JOIN produtos p ON p.id = cr.produto_id
      WHERE cr.ativo = TRUE
        AND cr.deleted_at IS NULL
        AND l.ativa = TRUE
        AND l.status_assinatura != 'cancelada'
        AND c.consentimento_whatsapp = TRUE   -- LGPD: só envia com consentimento
        AND cr.proxima_notificacao::date <= CURRENT_DATE
        AND NOT EXISTS (
          SELECT 1 FROM lembretes
          WHERE ciclo_id = cr.id
            AND status IN ('agendado', 'enviado')
        )
      LIMIT 100
    `;

    if (!ciclos.length) {
      this.logger.log('Nenhum ciclo vencido encontrado.');
      return;
    }

    this.logger.log(`${ciclos.length} ciclos para notificar.`);

    for (const ciclo of ciclos) {
      await this.agendarJobLembrete(ciclo);
    }
  }

  // ----------------------------------------------------------------
  // CRON 2 — Roda a cada 10 minutos
  // Busca lembretes enviados há mais de X horas sem resposta.
  // Se a loja tem retry_automatico = TRUE, agenda um retry.
  // ----------------------------------------------------------------
  @Cron(CronExpression.EVERY_10_MINUTES)
  async varrerLembretessSemResposta() {
    this.logger.log('🔍 Varrendo lembretes sem resposta...');

    const lembretes = await this.sql`
      SELECT
        l.id           AS lembrete_id,
        l.ciclo_id,
        l.loja_id,
        l.tentativa,
        lj.retry_automatico,
        lj.horas_para_retry
      FROM lembretes l
      JOIN lojas lj ON lj.id = l.loja_id
      WHERE l.status = 'enviado'
        AND lj.retry_automatico = TRUE
        AND l.tentativa = 1                        -- só faz retry uma vez
        AND l.enviado_em <= NOW() - (lj.horas_para_retry || ' hours')::INTERVAL
        AND NOT EXISTS (
          SELECT 1 FROM lembretes retry
          WHERE retry.lembrete_pai_id = l.id       -- não duplica se já tem retry
        )
      LIMIT 50
    `;

    if (!lembretes.length) return;

    this.logger.log(`${lembretes.length} lembretes aguardando retry.`);

    for (const lembrete of lembretes) {
      // Marca o original como sem_resposta antes de criar o retry
      await this.sql`
        UPDATE lembretes SET status = 'sem_resposta', updated_at = NOW()
        WHERE id = ${lembrete.lembreteId}
      `;

      // Enfileira o job de retry
      await this.filaRetry.add(
        JOB_RETRY_LEMBRETE,
        { lembreteOriginalId: lembrete.lembreteId, lojaId: lembrete.lojaId },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 30_000 },
          removeOnComplete: true,
        },
      );
    }
  }

  // ----------------------------------------------------------------
  // CRON 3 — Roda a cada hora
  // Limpa lembretes presos em 'enviado' há mais de 48h sem resposta nem retry.
  // Cobre o caso de retries (tentativa >= 2) que o CRON 2 não trata
  // e qualquer outro caso onde o lembrete ficou esquecido na fila.
  // ----------------------------------------------------------------
  @Cron(CronExpression.EVERY_HOUR)
  async limparLembretesEnviadosAntigos() {
    const result = await this.sql`
      UPDATE lembretes SET status = 'sem_resposta', updated_at = NOW()
      WHERE status = 'enviado'
        AND enviado_em <= NOW() - INTERVAL '48 hours'
        AND NOT EXISTS (
          SELECT 1 FROM lembretes retry
          WHERE retry.lembrete_pai_id = lembretes.id
        )
    `;
    if (result.count > 0) {
      this.logger.log(`${result.count} lembrete(s) antigos marcados como sem_resposta`);
    }
  }

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------

  private async agendarJobLembrete(ciclo: any) {
    // Primeiro cria o registro do lembrete no banco (status: agendado)
    const [lembrete] = await this.sql`
      INSERT INTO lembretes (loja_id, ciclo_id, agendado_para, status, tentativa)
      VALUES (${ciclo.lojaId}, ${ciclo.cicloId}, NOW(), 'agendado', 1)
      RETURNING id
    `;

    // Depois enfileira o job no BullMQ passando tudo que o worker vai precisar
    // para não ter que fazer outra query no banco durante a execução
    await this.filaLembretes.add(
      JOB_ENVIAR_LEMBRETE,
      {
        lembreteId:     lembrete.id,
        lojaId:         ciclo.lojaId,
        cicloId:        ciclo.cicloId,
        clienteNome:         ciclo.clienteNome,
        clienteWhatsappNome: ciclo.whatsappNome ?? null,
        clienteTelefone:     ciclo.clienteTelefone,
        produtoNome:    ciclo.produtoNome,
        produtoUnidade: ciclo.produtoUnidade,
        quantidade:     ciclo.quantidade,
        horarioAbertura:    ciclo.horarioAbertura,
        horarioFechamento:  ciclo.horarioFechamento,
        diasFuncionamento:  ciclo.diasFuncionamento,
        horasParaRetry:     ciclo.horasParaRetry,
      },
      {
        attempts: 3,                                    // tenta até 3x em caso de erro de rede
        backoff: { type: 'exponential', delay: 60_000 }, // espera 1min, 2min, 4min entre tentativas
        removeOnComplete: true,                          // limpa da fila após sucesso
        removeOnFail: false,                             // mantém na fila em caso de falha (para debug)
      },
    );

    this.logger.log(`Job agendado: lembrete ${lembrete.id} para ${ciclo.clienteNome}`);
  }

  // ----------------------------------------------------------------
  // CRON RESUMO DIÁRIO — 8h e 20h BRT (11h e 23h UTC)
  // Envia e-mail de saúde do sistema ao admin.
  // ----------------------------------------------------------------
  @Cron('0 11 * * *')
  async resumoDiario8h() {
    this.logger.log('[Cron] Resumo diário 8h BRT...');
    await this.enviarResumoDiario('Resumo 8h BRT').catch((e: any) =>
      this.logger.warn(`[Cron] erro no resumo 8h: ${e?.message}`),
    );
  }

  @Cron('0 23 * * *')
  async resumoDiario20h() {
    this.logger.log('[Cron] Resumo diário 20h BRT...');
    await this.enviarResumoDiario('Resumo 20h BRT').catch((e: any) =>
      this.logger.warn(`[Cron] erro no resumo 20h: ${e?.message}`),
    );
  }

  private async enviarResumoDiario(periodo: string) {
    const [lojaStats] = await this.sql`
      SELECT
        COUNT(*) FILTER (WHERE ativa = TRUE AND deleted_at IS NULL) AS total_ativas
      FROM lojas
    `;

    const falhaSilenciosa = await this.sql`
      SELECT l.id, l.nome
      FROM lojas l
      WHERE l.ativa = TRUE AND l.deleted_at IS NULL AND l.wa_status = 'conectado'
        AND l.wa_ultima_msg_individual_em IS NOT NULL
        AND l.wa_ultima_msg_individual_em < NOW() - INTERVAL '6 hours'
        AND (
          SELECT COUNT(*) FROM mensagens_whatsapp m
          WHERE m.loja_id = l.id AND m.direcao = 'recebida'
            AND m.created_at > NOW() - INTERVAL '30 days'
        ) >= 3
    `.catch(() => [] as any[]);

    const desconectadas = await this.sql`
      SELECT id, nome, wa_status
      FROM lojas
      WHERE ativa = TRUE AND deleted_at IS NULL AND wa_status != 'conectado'
      ORDER BY nome
    `.catch(() => [] as any[]);

    const inadimplentes = await this.sql`
      SELECT id, nome, status_assinatura
      FROM lojas
      WHERE ativa = TRUE AND deleted_at IS NULL
        AND status_assinatura IN ('inadimplente', 'suspensa')
      ORDER BY nome
    `.catch(() => [] as any[]);

    const [lembreteStats] = await this.sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'enviado' AND enviado_em >= NOW() - INTERVAL '12 hours') AS lembretes_enviados,
        COUNT(*) FILTER (WHERE status = 'falha') AS lembretes_represados
      FROM lembretes
    `.catch(() => [{ lembretesEnviados: 0, lembretesRepresados: 0 }]);

    const [pedidoStats] = await this.sql`
      SELECT
        COUNT(*) FILTER (WHERE status_jornada = 'comprou' AND confirmado_em >= NOW() - INTERVAL '12 hours') AS vendas_confirmadas,
        COALESCE(SUM(valor) FILTER (WHERE status_jornada = 'comprou' AND confirmado_em >= NOW() - INTERVAL '12 hours'), 0) AS receita_confirmada,
        COUNT(*) FILTER (WHERE status_jornada = 'comprou' AND valor IS NULL) AS vendas_sem_valor
      FROM pedidos
      WHERE deleted_at IS NULL
    `.catch(() => [{ vendasConfirmadas: 0, receitaConfirmada: 0, vendasSemValor: 0 }]);

    const [leadStats] = await this.sql`
      SELECT COUNT(*) AS novos_leads
      FROM clientes
      WHERE created_at >= NOW() - INTERVAL '12 hours' AND deleted_at IS NULL
    `.catch(() => [{ novosLeads: 0 }]);

    await this.emailService.enviarResumoDiario({
      falhaSilenciosa,
      desconectadas,
      inadimplentes,
      lembretesRepresados: Number(lembreteStats?.lembretesRepresados ?? 0),
      vendasSemValor:      Number(pedidoStats?.vendasSemValor ?? 0),
      totalAtivas:         Number(lojaStats?.totalAtivas ?? 0),
      lembretesEnviados:   Number(lembreteStats?.lembretesEnviados ?? 0),
      vendasConfirmadas:   Number(pedidoStats?.vendasConfirmadas ?? 0),
      receitaConfirmada:   Number(pedidoStats?.receitaConfirmada ?? 0),
      novosLeads:          Number(leadStats?.novosLeads ?? 0),
    }, periodo);
  }

  // ----------------------------------------------------------------
  // CRON DIÁRIO — Inadimplência e suspensão
  // Roda às 08:00 todo dia.
  // 1. Suspende lojas inadimplentes há 5+ dias (ativa = false)
  // 2. Envia aviso (banner) para as que ainda estão dentro do prazo
  // ----------------------------------------------------------------
  @Cron('0 8 * * *')
  async verificarInadimplentes() {
    this.logger.log('[Cron] Verificando inadimplentes...');
    const suspensas = await this.pagamentosService.suspenderInadimplentesVencidos();
    const avisadas  = await this.pagamentosService.avisarInadimplentesAtivos();
    this.logger.log(`[Cron] Inadimplentes: ${suspensas} suspensa(s), ${avisadas} avisada(s)`);
  }

  // ----------------------------------------------------------------
  // CRON DIÁRIO — Aplicar downgrades de plano agendados
  // Roda às 08:30. Aplica plano_pendente_slug quando prazo chegou,
  // desde que a contagem de clientes não exceda o novo limite.
  // ----------------------------------------------------------------
  @Cron('30 8 * * *')
  async aplicarDowngradesPendentes() {
    this.logger.log('[Cron] Verificando downgrades de plano pendentes...');
    const aplicados = await this.planosService.aplicarDowngradesPendentes();
    if (aplicados > 0) {
      this.logger.log(`[Cron] ${aplicados} downgrade(s) de plano aplicado(s)`);
    }
  }
}
