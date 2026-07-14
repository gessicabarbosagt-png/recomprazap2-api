import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DATABASE_CLIENT } from '../database/database.module';
import { CiclosService } from '../ciclos/ciclos.service';

export type StatusJornada = 'aguardando' | 'orcamento_enviado' | 'comprou' | 'nao_comprou';

export interface AtualizarPedidoDto {
  status?: 'confirmado' | 'entregue' | 'cancelado';
  tipoEntrega?: 'entrega' | 'retirada';
  tipoPagamento?: 'dinheiro' | 'pix' | 'cartao' | 'link';
  linkPagamento?: string;
}

export interface AtualizarJornadaDto {
  etapaId: string;       // UUID da etapa
  valor?: number | null;
}

export interface CriarPedidoDto {
  clienteId: string;
  etapaId: string;
  valor?: number | null;
}

@Injectable()
export class PedidosService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
    private readonly ciclosService: CiclosService,
  ) {}

  async listar(lojaId: string, status?: string, statusJornada?: string, diasAtras?: number, desde?: string) {
    // Pedidos confirmados filtram por confirmado_em; demais por created_at
    const usarConfirmadoEm = statusJornada === 'comprou';

    let filtroPeriodo: any;
    if (diasAtras) {
      filtroPeriodo = usarConfirmadoEm
        ? this.sql`AND p.confirmado_em >= NOW() - (${diasAtras} || ' days')::INTERVAL`
        : this.sql`AND p.created_at   >= NOW() - (${diasAtras} || ' days')::INTERVAL`;
    } else if (desde) {
      filtroPeriodo = usarConfirmadoEm
        ? this.sql`AND p.confirmado_em >= ${desde}::date`
        : this.sql`AND p.created_at   >= ${desde}::date`;
    } else {
      filtroPeriodo = this.sql``;
    }

    return this.sql`
      SELECT
        p.id,
        p.quantidade,
        p.preco_unitario,
        p.status,
        p.status_jornada,
        p.valor,
        p.confirmado_em,
        p.confirmado_por,
        p.tipo_entrega,
        p.tipo_pagamento,
        p.link_pagamento,
        p.fora_horario,
        p.created_at,
        c.id          AS cliente_id,
        c.nome        AS cliente_nome,
        c.telefone    AS cliente_telefone,
        pr.nome       AS produto_nome,
        pr.unidade    AS produto_unidade
      FROM pedidos p
      JOIN clientes c   ON c.id  = p.cliente_id
      LEFT JOIN produtos pr ON pr.id = p.produto_id
      WHERE p.loja_id = ${lojaId}
        AND p.deleted_at IS NULL
        ${status        ? this.sql`AND p.status         = ${status}`        : this.sql``}
        ${statusJornada ? this.sql`AND p.status_jornada = ${statusJornada}` : this.sql``}
        ${filtroPeriodo}
      ORDER BY p.created_at DESC
      LIMIT 200
    `;
  }

  async buscarPorId(id: string, lojaId: string) {
    const [pedido] = await this.sql`
      SELECT p.*, c.nome AS cliente_nome, c.telefone, pr.nome AS produto_nome
      FROM pedidos p
      JOIN clientes c  ON c.id  = p.cliente_id
      LEFT JOIN produtos pr ON pr.id = p.produto_id
      WHERE p.id = ${id} AND p.loja_id = ${lojaId} AND p.deleted_at IS NULL
    `;

    if (!pedido) throw new NotFoundException('Pedido não encontrado');
    return pedido;
  }

  // Retorna { pedidoAberto, ultimoPedidoFechado, historico } para o cliente
  async buscarAbertoPorCliente(clienteId: string, lojaId: string) {
    const [pedidoAberto] = await this.sql`
      SELECT p.id, p.status_jornada, p.etapa_id, p.valor, p.confirmado_em, p.confirmado_por,
             pr.nome AS produto_nome, p.created_at,
             ej.nome AS etapa_nome, ej.tipo AS etapa_tipo
      FROM pedidos p
      LEFT JOIN produtos pr ON pr.id = p.produto_id
      LEFT JOIN etapas_jornada ej ON ej.id = p.etapa_id
      WHERE p.cliente_id = ${clienteId}
        AND p.loja_id = ${lojaId}
        AND p.deleted_at IS NULL
        AND ej.tipo = 'intermediaria'
      ORDER BY p.created_at DESC
      LIMIT 1
    `;

    const [ultimoPedidoFechado] = await this.sql`
      SELECT p.id, p.status_jornada, p.etapa_id, p.valor, p.confirmado_em, p.confirmado_por,
             pr.nome AS produto_nome, p.created_at,
             ej.nome AS etapa_nome, ej.tipo AS etapa_tipo
      FROM pedidos p
      LEFT JOIN produtos pr ON pr.id = p.produto_id
      LEFT JOIN etapas_jornada ej ON ej.id = p.etapa_id
      WHERE p.cliente_id = ${clienteId}
        AND p.loja_id = ${lojaId}
        AND p.deleted_at IS NULL
        AND ej.tipo IN ('final_comprou', 'final_nao_comprou')
      ORDER BY p.created_at DESC
      LIMIT 1
    `;

    const historico = await this.sql`
      SELECT p.id, p.status_jornada, p.etapa_id, p.valor, p.confirmado_em, p.created_at,
             ej.nome AS etapa_nome, ej.tipo AS etapa_tipo
      FROM pedidos p
      LEFT JOIN etapas_jornada ej ON ej.id = p.etapa_id
      WHERE p.cliente_id = ${clienteId}
        AND p.loja_id = ${lojaId}
        AND p.deleted_at IS NULL
        AND ej.tipo IN ('final_comprou', 'final_nao_comprou')
      ORDER BY p.created_at DESC
      LIMIT 5
    `;

    return {
      pedidoAberto: pedidoAberto ?? null,
      ultimoPedidoFechado: ultimoPedidoFechado ?? null,
      historico,
    };
  }

  async atualizar(id: string, dto: AtualizarPedidoDto, lojaId: string) {
    const pedido = await this.buscarPorId(id, lojaId);

    if (['entregue', 'cancelado'].includes(pedido.status)) {
      throw new BadRequestException(
        `Pedido já está ${pedido.status} e não pode ser alterado`,
      );
    }

    const [atualizado] = await this.sql`
      UPDATE pedidos SET
        status         = COALESCE(${dto.status ?? null}, status),
        tipo_entrega   = COALESCE(${dto.tipoEntrega ?? null}, tipo_entrega),
        tipo_pagamento = COALESCE(${dto.tipoPagamento ?? null}, tipo_pagamento),
        link_pagamento = COALESCE(${dto.linkPagamento ?? null}, link_pagamento),
        updated_at     = NOW()
      WHERE id = ${id} AND loja_id = ${lojaId}
      RETURNING *
    `;

    if (dto.status === 'entregue') {
      if (pedido.lembreteId) {
        const [lembrete] = await this.sql`
          SELECT ciclo_id FROM lembretes WHERE id = ${pedido.lembreteId}
        `;
        if (lembrete) {
          await this.ciclosService.registrarCompra(lembrete.cicloId, lojaId);
        }
      }
    }

    return atualizado;
  }

  async atualizarJornada(id: string, lojaId: string, dto: AtualizarJornadaDto) {
    // Valida e busca a etapa
    const [etapa] = await this.sql`
      SELECT id, tipo FROM etapas_jornada WHERE id = ${dto.etapaId} AND loja_id = ${lojaId}
    `;
    if (!etapa) throw new NotFoundException('Etapa não encontrada ou não pertence a esta loja');

    // Normaliza valor: aceita número JS ou string '89,90'/'89.90'
    let valorNormalizado: number | null = null;
    if (dto.valor !== undefined && dto.valor !== null) {
      const valorStr = String(dto.valor).replace(',', '.');
      const parsed = parseFloat(valorStr);
      if (isNaN(parsed)) {
        throw new BadRequestException('Valor inválido — informe um número, ex: 89.90');
      }
      if (parsed < 0) {
        throw new BadRequestException('Valor não pode ser negativo');
      }
      valorNormalizado = parsed;
    }

    const finalizado = etapa.tipo === 'final_comprou' || etapa.tipo === 'final_nao_comprou';

    // Deriva status_jornada legado a partir do tipo da etapa
    let statusJornadaLegado: StatusJornada;
    if (etapa.tipo === 'final_comprou') {
      statusJornadaLegado = 'comprou';
    } else if (etapa.tipo === 'final_nao_comprou') {
      statusJornadaLegado = 'nao_comprou';
    } else {
      statusJornadaLegado = 'aguardando';
    }

    // COALESCE com cast explícito ::numeric resolve "could not determine data type of parameter $N"
    // quando valor é null — o PostgreSQL não consegue inferir o tipo via CASE WHEN ... IS NOT NULL
    const [atualizado] = await this.sql`
      UPDATE pedidos SET
        etapa_id       = ${dto.etapaId},
        status_jornada = ${statusJornadaLegado},
        valor          = COALESCE(${valorNormalizado}::numeric, valor),
        confirmado_em  = CASE WHEN ${finalizado} THEN NOW() ELSE confirmado_em END,
        confirmado_por = CASE WHEN ${finalizado} THEN 'manual' ELSE confirmado_por END,
        updated_at     = NOW()
      WHERE id = ${id} AND loja_id = ${lojaId} AND deleted_at IS NULL
      RETURNING id, etapa_id, status_jornada, valor, confirmado_em, confirmado_por
    `;
    if (!atualizado) throw new NotFoundException('Pedido não encontrado');
    return atualizado;
  }

  async criar(lojaId: string, dto: CriarPedidoDto) {
    // Valida e busca a etapa
    const [etapa] = await this.sql`
      SELECT id, tipo FROM etapas_jornada WHERE id = ${dto.etapaId} AND loja_id = ${lojaId}
    `;
    if (!etapa) throw new NotFoundException('Etapa não encontrada ou não pertence a esta loja');

    // Normaliza valor
    let valorNormalizado: number | null = null;
    if (dto.valor !== undefined && dto.valor !== null) {
      const valorStr = String(dto.valor).replace(',', '.');
      const parsed = parseFloat(valorStr);
      if (isNaN(parsed)) {
        throw new BadRequestException('Valor inválido — informe um número, ex: 89.90');
      }
      if (parsed < 0) {
        throw new BadRequestException('Valor não pode ser negativo');
      }
      valorNormalizado = parsed;
    }

    const finalizado = etapa.tipo === 'final_comprou' || etapa.tipo === 'final_nao_comprou';

    let statusJornadaLegado: StatusJornada;
    if (etapa.tipo === 'final_comprou') {
      statusJornadaLegado = 'comprou';
    } else if (etapa.tipo === 'final_nao_comprou') {
      statusJornadaLegado = 'nao_comprou';
    } else {
      statusJornadaLegado = 'aguardando';
    }

    const confirmedAt = finalizado ? new Date() : null;
    const confirmedBy = finalizado ? 'manual' : null;

    const [pedido] = await this.sql`
      INSERT INTO pedidos (loja_id, cliente_id, etapa_id, status_jornada, valor, confirmado_em, confirmado_por, status)
      VALUES (
        ${lojaId},
        ${dto.clienteId},
        ${dto.etapaId},
        ${statusJornadaLegado},
        ${valorNormalizado},
        ${confirmedAt},
        ${confirmedBy},
        'pendente'
      )
      RETURNING id, etapa_id, status_jornada, valor, confirmado_em, confirmado_por, created_at
    `;
    return pedido;
  }

  async resumoPorPeriodo(lojaId: string, diasAtras: number) {
    const [resumo] = await this.sql`
      SELECT
        COUNT(*)                                        AS total_pedidos,
        COUNT(*) FILTER (WHERE status = 'entregue')    AS total_entregues,
        COUNT(*) FILTER (WHERE status = 'cancelado')   AS total_cancelados,
        COUNT(*) FILTER (WHERE status = 'pendente')    AS total_pendentes,
        COALESCE(SUM(quantidade * preco_unitario)
          FILTER (WHERE status = 'entregue'), 0)        AS receita_estimada
      FROM pedidos
      WHERE loja_id = ${lojaId}
        AND deleted_at IS NULL
        AND created_at >= NOW() - (${diasAtras} || ' days')::INTERVAL
    `;
    return resumo;
  }

  async resumoJornada(lojaId: string, diasAtras: number) {
    // total_pedidos: pedidos criados no período (created_at)
    // total_compras / receita: vendas confirmadas no período (confirmado_em)
    // Isso garante consistência com a lista /pedidos?etapa=comprou&dias=N
    const [resumo] = await this.sql`
      SELECT
        COUNT(*) FILTER (WHERE created_at    >= NOW() - (${diasAtras} || ' days')::INTERVAL)
          AS total_pedidos,
        COUNT(*) FILTER (WHERE status_jornada = 'comprou'
                           AND confirmado_em >= NOW() - (${diasAtras} || ' days')::INTERVAL)
          AS total_compras,
        COUNT(*) FILTER (WHERE status_jornada = 'comprou'
                           AND confirmado_em >= NOW() - (${diasAtras} || ' days')::INTERVAL
                           AND valor IS NULL)
          AS compras_sem_valor,
        COALESCE(
          SUM(valor) FILTER (WHERE status_jornada = 'comprou'
                               AND confirmado_em >= NOW() - (${diasAtras} || ' days')::INTERVAL),
          0
        ) AS receita_confirmada
      FROM pedidos
      WHERE loja_id = ${lojaId}
        AND deleted_at IS NULL
    `;
    return resumo;
  }
}
