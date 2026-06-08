import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DATABASE_CLIENT } from '../database/database.module';
import { CiclosService } from '../ciclos/ciclos.service';

export interface AtualizarPedidoDto {
  status?: 'confirmado' | 'entregue' | 'cancelado';
  tipoEntrega?: 'entrega' | 'retirada';
  tipoPagamento?: 'dinheiro' | 'pix' | 'cartao' | 'link';
  linkPagamento?: string;
}

@Injectable()
export class PedidosService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
    private readonly ciclosService: CiclosService,
  ) {}

  // Lista pedidos da loja, com filtro opcional por status
  async listar(lojaId: string, status?: string) {
    return this.sql`
      SELECT
        p.id,
        p.quantidade,
        p.preco_unitario,
        p.status,
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
      JOIN produtos pr ON pr.id = p.produto_id
      WHERE p.loja_id = ${lojaId}
        AND p.deleted_at IS NULL
        ${status ? this.sql`AND p.status = ${status}` : this.sql``}
      ORDER BY p.created_at DESC
      LIMIT 100
    `;
  }

  // Busca pedido por ID
  async buscarPorId(id: string, lojaId: string) {
    const [pedido] = await this.sql`
      SELECT p.*, c.nome AS cliente_nome, c.telefone, pr.nome AS produto_nome
      FROM pedidos p
      JOIN clientes c  ON c.id  = p.cliente_id
      JOIN produtos pr ON pr.id = p.produto_id
      WHERE p.id = ${id} AND p.loja_id = ${lojaId} AND p.deleted_at IS NULL
    `;

    if (!pedido) throw new NotFoundException('Pedido não encontrado');
    return pedido;
  }

  // Atualiza o status do pedido.
  // Quando o status vai para 'entregue', registra a compra no ciclo
  // (o que empurra proxima_notificacao para a próxima data)
  async atualizar(id: string, dto: AtualizarPedidoDto, lojaId: string) {
    const pedido = await this.buscarPorId(id, lojaId);

    // Regra de negócio: não permite voltar atrás em status já finalizados
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

    // Se foi marcado como entregue, atualiza o ciclo para reiniciar a contagem
    if (dto.status === 'entregue') {
      // Busca o ciclo associado ao lembrete deste pedido
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

  // Resumo de pedidos para o relatório periódico (RF-42 a RF-46)
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
}
