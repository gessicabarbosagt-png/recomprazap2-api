import { Process, Processor } from '@nestjs/bull';
import { Logger, Inject } from '@nestjs/common';
import { Job } from 'bull';
import { DATABASE_CLIENT } from '../database/database.module';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import {
  FILA_LEMBRETES,
  JOB_ENVIAR_LEMBRETE,
} from './worker.constants';

// LembretesProcessor é o "executor" da fila de lembretes.
// O BullMQ pega os jobs da fila Redis e entrega aqui para processar.
//
// Cada @Process() corresponde a um tipo de job na fila.
// O NestJS cuida de criar a instância e injetar as dependências.

@Processor(FILA_LEMBRETES)
export class LembretesProcessor {
  private readonly logger = new Logger(LembretesProcessor.name);

  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
    private readonly whatsappService: WhatsappService,
  ) {}

  @Process(JOB_ENVIAR_LEMBRETE)
  async processarEnvioLembrete(job: Job) {
    const {
      lembreteId,
      lojaId,
      cicloId,
      clienteNome,
      clienteTelefone,
      produtoNome,
      produtoUnidade,
      quantidade,
      horarioAbertura,
      horarioFechamento,
      diasFuncionamento,
    } = job.data;

    this.logger.log(`Processando lembrete ${lembreteId} para ${clienteNome}`);

    // ---- Verifica horário de funcionamento ----
    // Se a loja não está aberta agora, reagenda para o próximo horário de abertura.
    // Isso evita mandar mensagem às 3h da manhã.
    const foraDoHorario = this.verificarForaDoHorario(
      horarioAbertura,
      horarioFechamento,
      diasFuncionamento,
    );

    if (foraDoHorario) {
      const proximaAbertura = this.calcularProximaAbertura(
        horarioAbertura,
        diasFuncionamento,
      );

      this.logger.log(
        `Loja fora do horário. Reagendando lembrete ${lembreteId} para ${proximaAbertura.toISOString()}`,
      );

      // Atualiza o agendado_para no banco e lança o job de volta para a fila
      // com delay calculado em milissegundos
      await this.sql`
        UPDATE lembretes SET agendado_para = ${proximaAbertura}, updated_at = NOW()
        WHERE id = ${lembreteId}
      `;

      const delayMs = proximaAbertura.getTime() - Date.now();
      await job.queue.add(JOB_ENVIAR_LEMBRETE, job.data, {
        delay: delayMs,
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: true,
      });

      return { reagendado: true, para: proximaAbertura };
    }

    // ---- Envia a mensagem via 360dialog ----
    try {
      await this.whatsappService.enviarLembrete({
        telefone: clienteTelefone,
        clienteNome,
        produtoNome,
        quantidade,
        unidade: produtoUnidade,
        lembreteId,
        lojaId,
      });

      // Atualiza o lembrete para 'enviado'
      await this.sql`
        UPDATE lembretes SET
          status     = 'enviado',
          enviado_em = NOW(),
          updated_at = NOW()
        WHERE id = ${lembreteId}
      `;

      this.logger.log(`✅ Lembrete ${lembreteId} enviado para ${clienteTelefone}`);
      return { enviado: true };

    } catch (err) {
      // Se der erro, o BullMQ vai retentar automaticamente (configurado no agendador)
      // O lembrete fica em 'agendado' até ter sucesso ou esgotar as tentativas
      this.logger.error(
        `❌ Erro ao enviar lembrete ${lembreteId}: ${err.message}`,
        err.stack,
      );
      throw err; // Re-lança para o BullMQ registrar a falha e retentar
    }
  }

  // ----------------------------------------------------------------
  // Helpers de horário
  // ----------------------------------------------------------------

  // Retorna true se o momento atual estiver fora do horário e dias de funcionamento da loja
  private verificarForaDoHorario(
    abertura: string | null,
    fechamento: string | null,
    dias: number[] | null,
  ): boolean {
    if (!abertura || !fechamento || !dias) return false; // sem restrição configurada

    const agora = new Date();
    const diaSemana = agora.getDay(); // 0=domingo, 6=sábado

    if (!dias.includes(diaSemana)) return true; // hoje não é dia de funcionamento

    const [hAb, mAb] = abertura.split(':').map(Number);
    const [hFe, mFe] = fechamento.split(':').map(Number);

    const minutoAtual   = agora.getHours() * 60 + agora.getMinutes();
    const minutoAbertura = hAb * 60 + mAb;
    const minutoFecho    = hFe * 60 + mFe;

    return minutoAtual < minutoAbertura || minutoAtual >= minutoFecho;
  }

  // Calcula a próxima data/hora de abertura da loja
  private calcularProximaAbertura(
    abertura: string | null,
    dias: number[] | null,
  ): Date {
    const proximo = new Date();

    if (!abertura || !dias) {
      // Sem configuração: agenda para daqui 1 hora como fallback
      proximo.setHours(proximo.getHours() + 1, 0, 0, 0);
      return proximo;
    }

    const [hora, minuto] = abertura.split(':').map(Number);

    // Tenta os próximos 7 dias para achar o próximo dia de funcionamento
    for (let i = 0; i <= 7; i++) {
      const candidato = new Date();
      candidato.setDate(candidato.getDate() + i);
      candidato.setHours(hora, minuto, 0, 0);

      if (dias.includes(candidato.getDay()) && candidato > new Date()) {
        return candidato;
      }
    }

    // Fallback: daqui 24h
    proximo.setDate(proximo.getDate() + 1);
    proximo.setHours(hora, minuto, 0, 0);
    return proximo;
  }
}
