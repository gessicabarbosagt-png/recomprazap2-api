import { Process, Processor } from '@nestjs/bull';
import { Logger, Inject } from '@nestjs/common';
import { Job } from 'bull';
import { DATABASE_CLIENT } from '../database/database.module';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { FILA_RETRY, JOB_RETRY_LEMBRETE } from './worker.constants';

// RetryProcessor lida com a segunda tentativa de contato.
// É separado do LembretesProcessor para ter configurações independentes
// (ex: poderia ter uma mensagem diferente no retry, ou um delay maior).

@Processor(FILA_RETRY)
export class RetryProcessor {
  private readonly logger = new Logger(RetryProcessor.name);

  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
    private readonly whatsappService: WhatsappService,
  ) {}

  @Process(JOB_RETRY_LEMBRETE)
  async processarRetry(job: Job) {
    const { lembreteOriginalId, lojaId } = job.data;

    this.logger.log(`Processando retry para lembrete original ${lembreteOriginalId}`);

    // Busca o lembrete original para pegar os dados do ciclo/cliente
    const [original] = await this.sql`
      SELECT
        l.id, l.ciclo_id, l.tentativa,
        cr.loja_id,
        c.nome      AS cliente_nome,
        c.telefone  AS cliente_telefone,
        p.nome      AS produto_nome,
        p.unidade   AS produto_unidade,
        cr.quantidade,
        lj.horas_para_retry
      FROM lembretes l
      JOIN ciclos_recompra cr ON cr.id = l.ciclo_id
      JOIN clientes c         ON c.id  = cr.cliente_id
      JOIN produtos p         ON p.id  = cr.produto_id
      JOIN lojas lj           ON lj.id = l.loja_id
      WHERE l.id = ${lembreteOriginalId}
    `;

    if (!original) {
      this.logger.warn(`Lembrete original ${lembreteOriginalId} não encontrado`);
      return;
    }

    // Cria o lembrete de retry no banco (tentativa = 2)
    const [retryLembrete] = await this.sql`
      INSERT INTO lembretes (loja_id, ciclo_id, agendado_para, status, tentativa, lembrete_pai_id)
      VALUES (${lojaId}, ${original.cicloId}, NOW(), 'agendado', 2, ${lembreteOriginalId})
      RETURNING id
    `;

    // Envia a mensagem — poderia ter texto diferente para retry,
    // mas mantemos o mesmo fluxo por simplicidade no MVP
    try {
      await this.whatsappService.enviarLembrete({
        telefone:    original.clienteTelefone,
        clienteNome: original.clienteNome,
        produtoNome: original.produtoNome,
        quantidade:  original.quantidade,
        unidade:     original.produtoUnidade,
        lembreteId:  retryLembrete.id,
      });

      await this.sql`
        UPDATE lembretes SET
          status     = 'enviado',
          enviado_em = NOW(),
          updated_at = NOW()
        WHERE id = ${retryLembrete.id}
      `;

      this.logger.log(`✅ Retry enviado para ${original.clienteNome}`);

    } catch (err) {
      this.logger.error(`❌ Erro no retry: ${err.message}`);
      throw err;
    }
  }
}
