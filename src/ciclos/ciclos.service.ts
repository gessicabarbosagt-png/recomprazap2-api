import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { DATABASE_CLIENT } from '../database/database.module';
import { WhatsappService } from '../whatsapp/whatsapp.service';

// DTO inline — idealmente ficaria em dto/criar-ciclo.dto.ts
// Mantido aqui para facilitar a leitura do service
export interface CriarCicloDto {
  clienteId: string;
  produtoId: string;
  intervaloDias: number;
  quantidade?: number;
}

export interface AtualizarCicloDto {
  intervaloDias?: number;
  quantidade?: number;
  ativo?: boolean;
}

@Injectable()
export class CiclosService {
  private readonly logger = new Logger(CiclosService.name);

  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
    private readonly whatsappService: WhatsappService,
  ) {}

  // Lista todos os ciclos ativos de uma loja, com dados do cliente e produto
  async listar(lojaId: string) {
    return this.sql`
      SELECT
        cr.id,
        cr.intervalo_dias,
        cr.quantidade,
        cr.ativo,
        cr.proxima_notificacao,
        cr.ultima_compra,
        cr.status_ultimo_envio,
        cr.created_at,
        -- Dados do cliente (para não precisar de uma segunda requisição no frontend)
        c.id   AS cliente_id,
        c.nome AS cliente_nome,
        c.telefone AS cliente_telefone,
        -- Dados do produto
        p.id   AS produto_id,
        p.nome AS produto_nome,
        p.preco AS produto_preco,
        p.unidade AS produto_unidade
      FROM ciclos_recompra cr
      JOIN clientes c ON c.id = cr.cliente_id
      JOIN produtos  p ON p.id = cr.produto_id
      WHERE cr.loja_id = ${lojaId}
        AND cr.deleted_at IS NULL
      ORDER BY cr.proxima_notificacao ASC NULLS LAST
    `;
  }

  // Busca um ciclo específico — garante isolamento por loja
  async buscarPorId(id: string, lojaId: string) {
    const [ciclo] = await this.sql`
      SELECT
        cr.*,
        c.nome AS cliente_nome,
        c.telefone AS cliente_telefone,
        p.nome AS produto_nome,
        p.preco AS produto_preco
      FROM ciclos_recompra cr
      JOIN clientes c ON c.id = cr.cliente_id
      JOIN produtos  p ON p.id = cr.produto_id
      WHERE cr.id = ${id}
        AND cr.loja_id = ${lojaId}
        AND cr.deleted_at IS NULL
    `;

    if (!ciclo) {
      throw new NotFoundException('Ciclo de recompra não encontrado');
    }

    return ciclo;
  }

  // Cria um novo ciclo e calcula a primeira próxima_notificacao (hoje + intervalo_dias)
  async criar(dto: CriarCicloDto, lojaId: string) {
    // Garante que cliente e produto pertencem a esta loja
    const [cliente] = await this.sql`
      SELECT id FROM clientes
      WHERE id = ${dto.clienteId} AND loja_id = ${lojaId} AND deleted_at IS NULL
    `;
    if (!cliente) throw new NotFoundException('Cliente não encontrado');

    const [produto] = await this.sql`
      SELECT id FROM produtos
      WHERE id = ${dto.produtoId} AND loja_id = ${lojaId} AND deleted_at IS NULL
    `;
    if (!produto) throw new NotFoundException('Produto não encontrado');

    // Evita duplicidade: um cliente não pode ter dois ciclos do mesmo produto
    const [existente] = await this.sql`
      SELECT id FROM ciclos_recompra
      WHERE cliente_id = ${dto.clienteId}
        AND produto_id = ${dto.produtoId}
        AND loja_id = ${lojaId}
        AND deleted_at IS NULL
    `;
    if (existente) {
      throw new ConflictException(
        'Este cliente já tem um ciclo ativo para esse produto',
      );
    }

    // proxima_notificacao = agora + intervalo_dias
    // O lembrete será disparado nessa data pelo worker BullMQ
    const [novoCiclo] = await this.sql`
      INSERT INTO ciclos_recompra
        (loja_id, cliente_id, produto_id, intervalo_dias, quantidade, proxima_notificacao)
      VALUES (
        ${lojaId},
        ${dto.clienteId},
        ${dto.produtoId},
        ${dto.intervaloDias},
        ${dto.quantidade ?? null},
        NOW() + (${dto.intervaloDias} || ' days')::INTERVAL
      )
      RETURNING *
    `;

    return novoCiclo;
  }

  // Atualiza intervalo ou quantidade. Se o intervalo mudar, recalcula proxima_notificacao.
  async atualizar(id: string, dto: AtualizarCicloDto, lojaId: string) {
    const ciclo = await this.buscarPorId(id, lojaId);

    // Se o intervalo mudou, recalcula a próxima notificação a partir de agora
    const novaProximaNotificacao = dto.intervaloDias && dto.intervaloDias !== ciclo.intervaloDias
      ? this.sql`NOW() + (${dto.intervaloDias} || ' days')::INTERVAL`
      : this.sql`${ciclo.proximaNotificacao}`;

    const [atualizado] = await this.sql`
      UPDATE ciclos_recompra SET
        intervalo_dias      = COALESCE(${dto.intervaloDias ?? null}, intervalo_dias),
        quantidade          = COALESCE(${dto.quantidade ?? null}, quantidade),
        ativo               = COALESCE(${dto.ativo ?? null}, ativo),
        proxima_notificacao = ${novaProximaNotificacao},
        updated_at          = NOW()
      WHERE id = ${id} AND loja_id = ${lojaId}
      RETURNING *
    `;

    return atualizado;
  }

  // Registra uma compra: atualiza ultima_compra e empurra a proxima_notificacao para frente
  // Chamado internamente quando um pedido é confirmado
  async registrarCompra(cicloId: string, lojaId: string) {
    const [atualizado] = await this.sql`
      UPDATE ciclos_recompra SET
        ultima_compra       = CURRENT_DATE,
        proxima_notificacao = NOW() + (intervalo_dias || ' days')::INTERVAL,
        updated_at          = NOW()
      WHERE id = ${cicloId}
        AND loja_id = ${lojaId}
        AND deleted_at IS NULL
      RETURNING *
    `;

    if (!atualizado) {
      throw new NotFoundException('Ciclo não encontrado para registrar compra');
    }

    return atualizado;
  }

  // Soft delete — desativa o ciclo sem apagar histórico
  async remover(id: string, lojaId: string) {
    await this.buscarPorId(id, lojaId);

    await this.sql`
      UPDATE ciclos_recompra SET
        deleted_at = NOW(),
        ativo = FALSE,
        updated_at = NOW()
      WHERE id = ${id} AND loja_id = ${lojaId}
    `;
  }

  // Dispara lembrete imediato para um ciclo específico
  async enviarLembreteImediato(id: string, lojaId: string) {
    const [ciclo] = await this.sql`
      SELECT cr.id, cr.quantidade,
             c.nome  AS cliente_nome,  c.telefone AS cliente_telefone,
             p.nome  AS produto_nome,  p.unidade  AS produto_unidade
      FROM ciclos_recompra cr
      JOIN clientes c ON c.id = cr.cliente_id
      JOIN produtos  p ON p.id = cr.produto_id
      WHERE cr.id = ${id} AND cr.loja_id = ${lojaId} AND cr.deleted_at IS NULL
    `;
    if (!ciclo) throw new NotFoundException('Ciclo não encontrado');

    const [lembrete] = await this.sql`
      INSERT INTO lembretes (loja_id, ciclo_id, status, agendado_para)
      VALUES (${lojaId}, ${id}, 'agendado', NOW())
      RETURNING id
    `;

    try {
      await this.whatsappService.enviarLembrete({
        telefone:     ciclo.clienteTelefone,
        clienteNome:  ciclo.clienteNome,
        produtoNome:  ciclo.produtoNome,
        quantidade:   ciclo.quantidade ?? undefined,
        unidade:      ciclo.produtoUnidade ?? undefined,
        lembreteId:   lembrete.id,
      });

      await this.sql`UPDATE lembretes SET status='enviado', enviado_em=NOW() WHERE id=${lembrete.id}`;
      await this.sql`UPDATE ciclos_recompra SET status_ultimo_envio='sucesso', updated_at=NOW() WHERE id=${id} AND loja_id=${lojaId}`;

      return { ok: true, status: 'sucesso' };
    } catch (err: any) {
      await this.sql`UPDATE lembretes SET status='cancelado' WHERE id=${lembrete.id}`;
      await this.sql`UPDATE ciclos_recompra SET status_ultimo_envio='erro', updated_at=NOW() WHERE id=${id} AND loja_id=${lojaId}`;
      throw err;
    }
  }

  // Retorna quantos ciclos estão vencidos e dispara todos em background (5s de delay entre cada)
  async dispararTodos(lojaId: string) {
    const ciclos = await this.sql`
      SELECT cr.id, cr.quantidade,
             c.nome  AS cliente_nome,  c.telefone AS cliente_telefone,
             p.nome  AS produto_nome,  p.unidade  AS produto_unidade
      FROM ciclos_recompra cr
      JOIN clientes c ON c.id = cr.cliente_id
      JOIN produtos  p ON p.id = cr.produto_id
      WHERE cr.loja_id = ${lojaId}
        AND cr.ativo = TRUE
        AND cr.deleted_at IS NULL
        AND cr.proxima_notificacao <= NOW()
    `;

    const total = ciclos.length;
    this.processarDisparoEmMassa(ciclos, lojaId).catch((err) =>
      this.logger.error('Erro no disparo em massa', err?.message),
    );

    return { total, mensagem: `Disparando ${total} lembrete(s) em background com intervalo de 5s` };
  }

  private async processarDisparoEmMassa(ciclos: any[], lojaId: string) {
    for (const ciclo of ciclos) {
      try {
        const [lembrete] = await this.sql`
          INSERT INTO lembretes (loja_id, ciclo_id, status, agendado_para)
          VALUES (${lojaId}, ${ciclo.id}, 'agendado', NOW())
          RETURNING id
        `;
        await this.whatsappService.enviarLembrete({
          telefone:    ciclo.clienteTelefone,
          clienteNome: ciclo.clienteNome,
          produtoNome: ciclo.produtoNome,
          quantidade:  ciclo.quantidade ?? undefined,
          unidade:     ciclo.produtoUnidade ?? undefined,
          lembreteId:  lembrete.id,
        });
        await this.sql`UPDATE lembretes SET status='enviado', enviado_em=NOW() WHERE id=${lembrete.id}`;
        await this.sql`UPDATE ciclos_recompra SET status_ultimo_envio='sucesso', updated_at=NOW() WHERE id=${ciclo.id}`;
      } catch (err: any) {
        this.logger.error(`Erro ao enviar lembrete para ciclo ${ciclo.id}`, err?.message);
        await this.sql`UPDATE ciclos_recompra SET status_ultimo_envio='erro', updated_at=NOW() WHERE id=${ciclo.id}`;
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}
