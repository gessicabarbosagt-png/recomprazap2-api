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
  statusJornada: StatusJornada;
  valor?: number | null;
}

@Injectable()
export class PedidosService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
    private readonly ciclosService: CiclosService,
  ) {}

  async listar(lojaId: string, status?: string) {
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
        c.nome  AS cliente_nome,
        c.telefone AS cliente_telefone,
        pr.nome AS produto_nome,
        pr.unidade AS produto_unidade
      FROM pedidos p
      JOIN clientes c  ON c.id  = p.cliente_id
      LEFT JOIN produtos pr ON pr.id = p.produto_id
      WHERE p.loja_id = ${lojaId}
        AND p.deleted_at IS NULL
        ${status ? this.sql`AND p.status = ${status}` : this.sql``}
      ORDER BY p.created_at DESC
      LIMIT 100
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

  // Retorna o pedido com jornada aberta (aguardando ou orcamento_enviado) mais recente do cliente
  async buscarAbertoPorCliente(clienteId: string, lojaId: string) {
    const [pedido] = await this.sql`
      SELECT p.id, p.status_jornada, p.valor, p.confirmado_em, p.confirmado_por,
             pr.nome AS produto_nome, p.created_at
      FROM pedidos p
      LEFT JOIN produtos pr ON pr.id = p.produto_id
      WHERE p.cliente_id = ${clienteId}
        AND p.loja_id = ${lojaId}
        AND p.deleted_at IS NULL
        AND p.status_jornada IN ('aguardando', 'orcamento_enviado')
      ORDER BY p.created_at DESC
      LIMIT 1
    `;
    return pedido ?? null;
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
    const finalizado = ['comprou', 'nao_comprou'].includes(dto.statusJornada);
    const [atualizado] = await this.sql`
      UPDATE pedidos SET
        status_jornada = ${dto.statusJornada},
        valor = CASE WHEN ${dto.valor ?? null} IS NOT NULL THEN ${dto.valor ?? null} ELSE valor END,
        confirmado_em  = CASE WHEN ${finalizado} THEN NOW() ELSE confirmado_em END,
        confirmado_por = CASE WHEN ${finalizado} THEN 'manual' ELSE confirmado_por END,
        updated_at     = NOW()
      WHERE id = ${id} AND loja_id = ${lojaId} AND deleted_at IS NULL
      RETURNING id, status_jornada, valor, confirmado_em, confirmado_por
    `;
    if (!atualizado) throw new NotFoundException('Pedido não encontrado');
    return atualizado;
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
    const [resumo] = await this.sql`
      SELECT
        COUNT(*)                                                 AS total_pedidos,
        COUNT(*) FILTER (WHERE status_jornada = 'comprou')       AS total_compras,
        COUNT(*) FILTER (WHERE status_jornada = 'comprou'
                              AND valor IS NULL)                  AS compras_sem_valor,
        COALESCE(SUM(valor) FILTER (WHERE status_jornada = 'comprou'), 0) AS receita_confirmada
      FROM pedidos
      WHERE loja_id = ${lojaId}
        AND deleted_at IS NULL
        AND created_at >= NOW() - (${diasAtras} || ' days')::INTERVAL
    `;
    return resumo;
  }
}
