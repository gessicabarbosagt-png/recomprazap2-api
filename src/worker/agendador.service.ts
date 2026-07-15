import { Injectable, Logger, Inject } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DATABASE_CLIENT } from '../database/database.module';
import {
  FILA_LEMBRETES,
  FILA_RETRY,
  JOB_ENVIAR_LEMBRETE,
  JOB_VERIFICAR_RESPOSTA,
  JOB_RETRY_LEMBRETE,
} from './worker.constants';

// AgendadorService é o "despertador" do sistema.
// Roda em background e fica monitorando o banco para disparar jobs.
//
// Dois Crons principais:
//   1. A cada 5 minutos: varre ciclos com proxima_notificacao vencida → agenda lembrete
//   2. A cada 10 minutos: varre lembretes enviados sem resposta → agenda retry

@Injectable()
export class AgendadorService {
  private readonly logger = new Logger(AgendadorService.name);

  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
    @InjectQueue(FILA_LEMBRETES) private readonly filaLembretes: Queue,
    @InjectQueue(FILA_RETRY) private readonly filaRetry: Queue,
  ) {}

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
        AND c.consentimento_whatsapp = TRUE   -- LGPD: só envia com consentimento
        AND cr.proxima_notificacao <= NOW()
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
}
