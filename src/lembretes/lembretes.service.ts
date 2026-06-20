import {
  Injectable,
  Inject,
  NotFoundException,
} from '@nestjs/common';
import { DATABASE_CLIENT } from '../database/database.module';

@Injectable()
export class LembretesService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
  ) {}

  // Lista lembretes de uma loja, com dados do ciclo/cliente/produto
  async listar(lojaId: string, status?: string) {
    return this.sql`
      SELECT
        l.id,
        l.status,
        l.agendado_para,
        l.enviado_em,
        l.tentativa,
        l.created_at,
        -- Dados do ciclo e seus relacionamentos
        cr.id            AS ciclo_id,
        cr.intervalo_dias,
        c.id             AS cliente_id,
        c.nome           AS cliente_nome,
        c.telefone       AS cliente_telefone,
        p.nome           AS produto_nome
      FROM lembretes l
      JOIN ciclos_recompra cr ON cr.id = l.ciclo_id
      JOIN clientes c         ON c.id  = cr.cliente_id
      JOIN produtos p         ON p.id  = cr.produto_id
      WHERE l.loja_id = ${lojaId}
        ${status ? this.sql`AND l.status = ${status}` : this.sql``}
      ORDER BY l.agendado_para DESC
      LIMIT 100
    `;
  }

  // Busca um lembrete específico
  async buscarPorId(id: string, lojaId: string) {
    const [lembrete] = await this.sql`
      SELECT l.*, c.nome AS cliente_nome, c.telefone AS cliente_telefone, p.nome AS produto_nome
      FROM lembretes l
      JOIN ciclos_recompra cr ON cr.id = l.ciclo_id
      JOIN clientes c         ON c.id  = cr.cliente_id
      JOIN produtos p         ON p.id  = cr.produto_id
      WHERE l.id = ${id} AND l.loja_id = ${lojaId}
    `;

    if (!lembrete) throw new NotFoundException('Lembrete não encontrado');
    return lembrete;
  }

  // Agenda um lembrete para um ciclo.
  // Normalmente chamado pelo worker que monitora ciclos com proxima_notificacao vencida,
  // mas pode ser chamado manualmente pelo lojista também.
  async agendar(cicloId: string, lojaId: string, agendadoPara?: Date) {
    // Verifica se o ciclo existe e pertence à loja
    const [ciclo] = await this.sql`
      SELECT id, proxima_notificacao FROM ciclos_recompra
      WHERE id = ${cicloId} AND loja_id = ${lojaId}
        AND ativo = TRUE AND deleted_at IS NULL
    `;
    if (!ciclo) throw new NotFoundException('Ciclo não encontrado');

    // Usa a proxima_notificacao do ciclo se não for passado um horário explícito
    const quando = agendadoPara ?? ciclo.proximaNotificacao ?? new Date();

    const [lembrete] = await this.sql`
      INSERT INTO lembretes (loja_id, ciclo_id, agendado_para, status, tentativa)
      VALUES (${lojaId}, ${cicloId}, ${quando}, 'agendado', 1)
      RETURNING *
    `;

    return lembrete;
  }

  // Marca um lembrete como enviado (chamado pelo worker após enviar para a 360dialog)
  async marcarEnviado(id: string) {
    const [atualizado] = await this.sql`
      UPDATE lembretes SET
        status     = 'enviado',
        enviado_em = NOW(),
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return atualizado;
  }

  // Marca como sem_resposta (chamado pelo worker de retry após o prazo expirar)
  async marcarSemResposta(id: string) {
    const [atualizado] = await this.sql`
      UPDATE lembretes SET
        status     = 'sem_resposta',
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return atualizado;
  }

  // Cancela um lembrete agendado (chamado manualmente pelo lojista)
  async cancelar(id: string, lojaId: string) {
    await this.buscarPorId(id, lojaId);

    await this.sql`
      UPDATE lembretes SET
        status     = 'cancelado',
        updated_at = NOW()
      WHERE id = ${id} AND loja_id = ${lojaId} AND status = 'agendado'
    `;
  }

  // Cria um retry: novo lembrete vinculado ao original, com tentativa + 1
  // Chamado quando o cliente não respondeu e a loja tem retry_automatico = TRUE
  async criarRetry(lembreteOriginalId: string, lojaId: string, horasDelay: number) {
    const original = await this.buscarPorId(lembreteOriginalId, lojaId);

    // O retry vai ser agendado X horas depois do original
    const [retry] = await this.sql`
      INSERT INTO lembretes (loja_id, ciclo_id, agendado_para, status, tentativa, lembrete_pai_id)
      VALUES (
        ${lojaId},
        ${original.cicloId},
        NOW() + (${horasDelay} || ' hours')::INTERVAL,
        'agendado',
        ${original.tentativa + 1},
        ${lembreteOriginalId}
      )
      RETURNING *
    `;

    return retry;
  }

  // Resumo para o relatório periódico (RF-42 a RF-46)
  // Retorna contagens de lembretes no período informado
  async resumoPorPeriodo(lojaId: string, diasAtras: number) {
    const [resumo] = await this.sql`
      SELECT
        COUNT(*)                                        AS total_enviados,
        COUNT(*) FILTER (WHERE status = 'respondido')  AS total_respondidos,
        COUNT(*) FILTER (WHERE status = 'sem_resposta') AS total_sem_resposta,
        COUNT(*) FILTER (WHERE status = 'cancelado')   AS total_cancelados,
        ROUND(
          COUNT(*) FILTER (WHERE status = 'respondido')::numeric
          / NULLIF(COUNT(*) FILTER (WHERE status IN ('enviado','respondido','sem_resposta')), 0) * 100,
          1
        ) AS taxa_resposta_pct
      FROM lembretes
      WHERE loja_id = ${lojaId}
        AND created_at >= NOW() - (${diasAtras} || ' days')::INTERVAL
    `;
    return resumo;
  }
}
