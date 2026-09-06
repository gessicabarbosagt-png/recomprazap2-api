import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { DATABASE_CLIENT } from '../database/database.module';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { AtividadeLogService } from '../atividade-log/atividade-log.service';

export interface CicloProdutoInput {
  id: string;
  quantidade?: number | null;
  unidade?: 'kg' | 'grama' | 'pacote' | 'unidade' | null;
}

export interface CriarCicloDto {
  clienteId: string;
  produtos: CicloProdutoInput[];
  intervaloDias: number;
  horarioEnvio?: string;
}

export interface AtualizarCicloDto {
  intervaloDias?: number;
  ativo?: boolean;
  horarioEnvio?: string;
  produtos?: CicloProdutoInput[];
}

interface ProdutoComQtd {
  nome: string;
  quantidade?: number | null;
  unidade?: string | null;
}

function pluralUnidade(u: string): string {
  const map: Record<string, string> = {
    kg: 'kg',
    grama: 'gramas',
    pacote: 'pacotes',
    unidade: 'unidades',
  };
  return map[u] ?? u;
}

function formatarItemProduto(p: ProdutoComQtd): string {
  if (p.quantidade != null && p.unidade) {
    return `${p.quantidade} ${pluralUnidade(p.unidade)} de ${p.nome}`;
  }
  return p.nome;
}

// Formata lista de produtos (com quantidade/unidade opcionais) para mensagem natural.
export function formatarNomesProdutos(produtos: ProdutoComQtd[]): string {
  if (produtos.length === 0) return 'produto';
  const partes = produtos.map(formatarItemProduto);
  if (partes.length === 1) return partes[0];
  if (partes.length === 2) return `${partes[0]} e ${partes[1]}`;
  return partes.slice(0, -1).join(', ') + ' e ' + partes[partes.length - 1];
}

@Injectable()
export class CiclosService {
  private readonly logger = new Logger(CiclosService.name);

  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
    private readonly whatsappService: WhatsappService,
    private readonly atividadeLog: AtividadeLogService,
  ) {}

  async listar(lojaId: string) {
    return this.sql`
      SELECT
        cr.id,
        cr.intervalo_dias,
        cr.ativo,
        cr.proxima_notificacao,
        cr.ultima_compra,
        cr.status_ultimo_envio,
        cr.horario_envio,
        cr.created_at,
        c.id        AS cliente_id,
        c.nome      AS cliente_nome,
        c.telefone  AS cliente_telefone,
        ARRAY(
          SELECT JSON_BUILD_OBJECT(
            'id', p.id, 'nome', p.nome,
            'quantidade', cp.quantidade, 'unidade', cp.unidade
          )
          FROM ciclo_produtos cp
          JOIN produtos p ON p.id = cp.produto_id
          WHERE cp.ciclo_id = cr.id
          ORDER BY p.nome
        ) AS produtos
      FROM ciclos_recompra cr
      JOIN clientes c ON c.id = cr.cliente_id
      WHERE cr.loja_id = ${lojaId}
        AND cr.deleted_at IS NULL
      ORDER BY cr.proxima_notificacao ASC NULLS LAST
    `;
  }

  async buscarPorId(id: string, lojaId: string) {
    const [ciclo] = await this.sql`
      SELECT
        cr.*,
        c.nome      AS cliente_nome,
        c.telefone  AS cliente_telefone,
        ARRAY(
          SELECT JSON_BUILD_OBJECT(
            'id', p.id, 'nome', p.nome,
            'quantidade', cp.quantidade, 'unidade', cp.unidade
          )
          FROM ciclo_produtos cp
          JOIN produtos p ON p.id = cp.produto_id
          WHERE cp.ciclo_id = cr.id
          ORDER BY p.nome
        ) AS produtos
      FROM ciclos_recompra cr
      JOIN clientes c ON c.id = cr.cliente_id
      WHERE cr.id = ${id}
        AND cr.loja_id = ${lojaId}
        AND cr.deleted_at IS NULL
    `;

    if (!ciclo) throw new NotFoundException('Ciclo de recompra não encontrado');
    return ciclo;
  }

  async criar(dto: CriarCicloDto, lojaId: string) {
    if (!dto.produtos?.length) {
      throw new BadRequestException('Informe pelo menos um produto');
    }

    const produtoIds = dto.produtos.map((p) => p.id);

    const [cliente] = await this.sql`
      SELECT id FROM clientes
      WHERE id = ${dto.clienteId} AND loja_id = ${lojaId} AND deleted_at IS NULL
    `;
    if (!cliente) throw new NotFoundException('Cliente não encontrado');

    const produtosValidos = await this.sql`
      SELECT id, nome FROM produtos
      WHERE id = ANY(${produtoIds}) AND loja_id = ${lojaId} AND deleted_at IS NULL
    `;
    if (produtosValidos.length !== produtoIds.length) {
      throw new NotFoundException('Um ou mais produtos não encontrados');
    }

    const [conflito] = await this.sql`
      SELECT cr.id FROM ciclos_recompra cr
      JOIN ciclo_produtos cp ON cp.ciclo_id = cr.id
      WHERE cr.cliente_id = ${dto.clienteId}
        AND cp.produto_id = ANY(${produtoIds})
        AND cr.loja_id = ${lojaId}
        AND cr.deleted_at IS NULL
    `;
    if (conflito) {
      throw new ConflictException(
        'Um ou mais produtos já fazem parte de um ciclo ativo para este cliente',
      );
    }

    const horarioEnvio = dto.horarioEnvio ?? '09:00';

    const [novoCiclo] = await this.sql`
      INSERT INTO ciclos_recompra
        (loja_id, cliente_id, produto_id, intervalo_dias, horario_envio, proxima_notificacao)
      VALUES (
        ${lojaId},
        ${dto.clienteId},
        ${produtoIds[0]},
        ${dto.intervaloDias},
        ${horarioEnvio},
        NOW() + (${dto.intervaloDias} || ' days')::INTERVAL
      )
      RETURNING id
    `;

    for (const prod of dto.produtos) {
      await this.sql`
        INSERT INTO ciclo_produtos (ciclo_id, produto_id, quantidade, unidade)
        VALUES (${novoCiclo.id}, ${prod.id}, ${prod.quantidade ?? null}, ${prod.unidade ?? null})
        ON CONFLICT (ciclo_id, produto_id) DO UPDATE SET
          quantidade = EXCLUDED.quantidade,
          unidade    = EXCLUDED.unidade
      `;
    }

    void (async () => {
      try {
        const nomes = produtosValidos.map((p: any) => ({ nome: p.nome ?? p.id }));
        void this.atividadeLog.registrar(lojaId, 'ciclo_criado',
          `Ciclo de ${formatarNomesProdutos(nomes)} criado para cliente (${dto.intervaloDias}d)`);
      } catch { /* silent */ }
    })();

    return this.buscarPorId(novoCiclo.id, lojaId);
  }

  async atualizar(id: string, dto: AtualizarCicloDto, lojaId: string) {
    const ciclo = await this.buscarPorId(id, lojaId);

    if (dto.produtos !== undefined) {
      if (!dto.produtos.length) {
        throw new BadRequestException('Informe pelo menos um produto');
      }
      const produtoIds = dto.produtos.map((p) => p.id);

      const produtosValidos = await this.sql`
        SELECT id FROM produtos
        WHERE id = ANY(${produtoIds}) AND loja_id = ${lojaId} AND deleted_at IS NULL
      `;
      if (produtosValidos.length !== produtoIds.length) {
        throw new NotFoundException('Um ou mais produtos não encontrados');
      }

      const [conflito] = await this.sql`
        SELECT cr.id FROM ciclos_recompra cr
        JOIN ciclo_produtos cp ON cp.ciclo_id = cr.id
        WHERE cr.cliente_id = ${ciclo.clienteId}
          AND cp.produto_id = ANY(${produtoIds})
          AND cr.loja_id = ${lojaId}
          AND cr.id != ${id}
          AND cr.deleted_at IS NULL
      `;
      if (conflito) {
        throw new ConflictException(
          'Um ou mais produtos já fazem parte de outro ciclo ativo para este cliente',
        );
      }

      await this.sql`DELETE FROM ciclo_produtos WHERE ciclo_id = ${id}`;
      for (const prod of dto.produtos) {
        await this.sql`
          INSERT INTO ciclo_produtos (ciclo_id, produto_id, quantidade, unidade)
          VALUES (${id}, ${prod.id}, ${prod.quantidade ?? null}, ${prod.unidade ?? null})
          ON CONFLICT (ciclo_id, produto_id) DO UPDATE SET
            quantidade = EXCLUDED.quantidade,
            unidade    = EXCLUDED.unidade
        `;
      }

      await this.sql`
        UPDATE ciclos_recompra SET produto_id = ${produtoIds[0]}, updated_at = NOW()
        WHERE id = ${id} AND loja_id = ${lojaId}
      `;
    }

    const novaProximaNotificacao = dto.intervaloDias && dto.intervaloDias !== ciclo.intervaloDias
      ? this.sql`NOW() + (${dto.intervaloDias} || ' days')::INTERVAL`
      : this.sql`${ciclo.proximaNotificacao}`;

    const [atualizado] = await this.sql`
      UPDATE ciclos_recompra SET
        intervalo_dias      = COALESCE(${dto.intervaloDias ?? null}, intervalo_dias),
        ativo               = COALESCE(${dto.ativo ?? null}, ativo),
        horario_envio       = COALESCE(${dto.horarioEnvio ?? null}, horario_envio),
        proxima_notificacao = ${novaProximaNotificacao},
        updated_at          = NOW()
      WHERE id = ${id} AND loja_id = ${lojaId}
      RETURNING *
    `;

    return atualizado;
  }

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
    if (!atualizado) throw new NotFoundException('Ciclo não encontrado para registrar compra');
    return atualizado;
  }

  async listarAdiados(lojaId: string) {
    return this.sql`
      SELECT
        cr.id,
        cr.proxima_notificacao,
        cr.data_original_disparo,
        cr.prazo_solicitado_dias,
        cr.precisa_revisao,
        cr.ativo,
        c.id        AS cliente_id,
        c.nome      AS cliente_nome,
        c.telefone  AS cliente_telefone,
        ARRAY(
          SELECT p.nome
          FROM ciclo_produtos cp
          JOIN produtos p ON p.id = cp.produto_id
          WHERE cp.ciclo_id = cr.id
          ORDER BY p.nome
        ) AS produto_nomes
      FROM ciclos_recompra cr
      JOIN clientes c ON c.id = cr.cliente_id
      WHERE cr.loja_id = ${lojaId}
        AND cr.adiado_pelo_cliente = TRUE
        AND cr.deleted_at IS NULL
      ORDER BY cr.proxima_notificacao ASC
    `;
  }

  async cancelarAdiamento(id: string, lojaId: string) {
    const [ciclo] = await this.sql`
      SELECT data_original_disparo FROM ciclos_recompra
      WHERE id = ${id} AND loja_id = ${lojaId} AND deleted_at IS NULL AND adiado_pelo_cliente = TRUE
    `;
    if (!ciclo) throw new NotFoundException('Ciclo não encontrado ou não está adiado');

    await this.sql`
      UPDATE ciclos_recompra SET
        proxima_notificacao   = COALESCE(${ciclo.dataOriginalDisparo}, proxima_notificacao),
        adiado_pelo_cliente   = FALSE,
        data_original_disparo = NULL,
        prazo_solicitado_dias = NULL,
        precisa_revisao       = FALSE,
        updated_at            = NOW()
      WHERE id = ${id} AND loja_id = ${lojaId}
    `;
  }

  async editarDataAdiado(id: string, lojaId: string, novaData: Date) {
    const [ciclo] = await this.sql`
      SELECT id FROM ciclos_recompra WHERE id = ${id} AND loja_id = ${lojaId} AND deleted_at IS NULL
    `;
    if (!ciclo) throw new NotFoundException('Ciclo não encontrado');

    await this.sql`
      UPDATE ciclos_recompra SET
        proxima_notificacao = ${novaData},
        updated_at          = NOW()
      WHERE id = ${id} AND loja_id = ${lojaId}
    `;
  }

  async remover(id: string, lojaId: string) {
    await this.buscarPorId(id, lojaId);
    await this.sql`
      UPDATE ciclos_recompra SET
        deleted_at = NOW(),
        ativo      = FALSE,
        updated_at = NOW()
      WHERE id = ${id} AND loja_id = ${lojaId}
    `;
  }

  async enviarLembreteImediato(id: string, lojaId: string) {
    const [ciclo] = await this.sql`
      SELECT
        cr.id,
        c.nome  AS cliente_nome,
        c.telefone AS cliente_telefone,
        cr.quantidade AS quantidade_legado,
        ARRAY(
          SELECT JSON_BUILD_OBJECT(
            'nome', p.nome, 'quantidade', cp.quantidade, 'unidade', cp.unidade
          )
          FROM ciclo_produtos cp
          JOIN produtos p ON p.id = cp.produto_id
          WHERE cp.ciclo_id = cr.id
          ORDER BY p.nome
        ) AS produtos_info
      FROM ciclos_recompra cr
      JOIN clientes c ON c.id = cr.cliente_id
      WHERE cr.id = ${id} AND cr.loja_id = ${lojaId} AND cr.deleted_at IS NULL
    `;
    if (!ciclo) throw new NotFoundException('Ciclo não encontrado');

    const produtosInfo: ProdutoComQtd[] = ciclo.produtosInfo ?? [];
    const temQtdPorProduto = produtosInfo.some((p) => p.quantidade != null || p.unidade);
    const produtoNome = formatarNomesProdutos(produtosInfo);
    const quantidade = temQtdPorProduto ? undefined : (ciclo.quantidadeLegado ?? undefined);

    const [lembrete] = await this.sql`
      INSERT INTO lembretes (loja_id, ciclo_id, status, agendado_para)
      VALUES (${lojaId}, ${id}, 'agendado', NOW())
      RETURNING id
    `;

    try {
      await this.whatsappService.enviarLembrete({
        telefone:    ciclo.clienteTelefone,
        clienteNome: ciclo.clienteNome,
        produtoNome,
        quantidade,
        lembreteId:  lembrete.id,
        lojaId,
      });

      await this.sql`UPDATE lembretes SET status='enviado', enviado_em=NOW() WHERE id=${lembrete.id}`;
      const [atualizado] = await this.sql`
        UPDATE ciclos_recompra SET
          status_ultimo_envio   = 'sucesso',
          proxima_notificacao   = NOW() + (intervalo_dias || ' days')::INTERVAL,
          adiado_pelo_cliente   = FALSE,
          data_original_disparo = NULL,
          prazo_solicitado_dias = NULL,
          precisa_revisao       = FALSE,
          updated_at            = NOW()
        WHERE id = ${id} AND loja_id = ${lojaId}
        RETURNING proxima_notificacao
      `;

      return { ok: true, status: 'sucesso', proximaNotificacao: atualizado.proximaNotificacao };
    } catch (err: any) {
      await this.sql`UPDATE lembretes SET status='cancelado' WHERE id=${lembrete.id}`;
      await this.sql`UPDATE ciclos_recompra SET status_ultimo_envio='erro', updated_at=NOW() WHERE id=${id} AND loja_id=${lojaId}`;
      throw err;
    }
  }

  async dispararTodos(lojaId: string) {
    const ciclos = await this.sql`
      SELECT cr.id, c.nome AS cliente_nome
      FROM ciclos_recompra cr
      JOIN clientes c ON c.id = cr.cliente_id
      WHERE cr.loja_id = ${lojaId}
        AND cr.ativo = TRUE
        AND cr.deleted_at IS NULL
        AND cr.proxima_notificacao::date <= CURRENT_DATE
    `;

    const resultados: { id: string; clienteNome: string; ok: boolean; erro?: string }[] = [];

    for (const ciclo of ciclos) {
      try {
        await this.enviarLembreteImediato(ciclo.id, lojaId);
        resultados.push({ id: ciclo.id, clienteNome: ciclo.clienteNome, ok: true });
      } catch (err: any) {
        this.logger.error(`Erro ao enviar lembrete para ciclo ${ciclo.id}`, err?.message);
        resultados.push({
          id: ciclo.id,
          clienteNome: ciclo.clienteNome,
          ok: false,
          erro: err?.response?.message ?? err?.message ?? 'Erro desconhecido',
        });
      }
    }

    const sucesso = resultados.filter((r) => r.ok).length;
    const falhas  = resultados.filter((r) => !r.ok).length;
    return { total: ciclos.length, sucesso, falhas, resultados };
  }
}
