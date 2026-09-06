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

export interface CriarCicloDto {
  clienteId: string;
  produtoIds: string[];   // múltiplos produtos por ciclo
  intervaloDias: number;
  quantidade?: string;
  horarioEnvio?: string;  // ex: '09:00' — padrão '09:00' se omitido
}

export interface AtualizarCicloDto {
  intervaloDias?: number;
  quantidade?: string;
  ativo?: boolean;
  horarioEnvio?: string;
  produtoIds?: string[];  // se fornecido, substitui todos os produtos do ciclo
}

// Formata lista de nomes de produtos para mensagem natural.
// Ex: ["A"] → "A" | ["A","B"] → "A e B" | ["A","B","C"] → "A, B e C"
function formatarNomesProdutos(nomes: string[]): string {
  if (nomes.length === 0) return 'produto';
  if (nomes.length === 1) return nomes[0];
  if (nomes.length === 2) return `${nomes[0]} e ${nomes[1]}`;
  return nomes.slice(0, -1).join(', ') + ' e ' + nomes[nomes.length - 1];
}

@Injectable()
export class CiclosService {
  private readonly logger = new Logger(CiclosService.name);

  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
    private readonly whatsappService: WhatsappService,
    private readonly atividadeLog: AtividadeLogService,
  ) {}

  // Lista todos os ciclos ativos de uma loja, com dados do cliente e produtos
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
        cr.horario_envio,
        cr.created_at,
        c.id        AS cliente_id,
        c.nome      AS cliente_nome,
        c.telefone  AS cliente_telefone,
        ARRAY(
          SELECT JSON_BUILD_OBJECT('id', p.id, 'nome', p.nome)
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

  // Busca um ciclo específico — garante isolamento por loja
  async buscarPorId(id: string, lojaId: string) {
    const [ciclo] = await this.sql`
      SELECT
        cr.*,
        c.nome      AS cliente_nome,
        c.telefone  AS cliente_telefone,
        ARRAY(
          SELECT JSON_BUILD_OBJECT('id', p.id, 'nome', p.nome)
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

  // Cria um novo ciclo com um ou mais produtos
  async criar(dto: CriarCicloDto, lojaId: string) {
    if (!dto.produtoIds?.length) {
      throw new BadRequestException('Informe pelo menos um produto');
    }

    const [cliente] = await this.sql`
      SELECT id FROM clientes
      WHERE id = ${dto.clienteId} AND loja_id = ${lojaId} AND deleted_at IS NULL
    `;
    if (!cliente) throw new NotFoundException('Cliente não encontrado');

    // Valida que todos os produtos pertencem à loja
    const produtosValidos = await this.sql`
      SELECT id FROM produtos
      WHERE id = ANY(${dto.produtoIds}) AND loja_id = ${lojaId} AND deleted_at IS NULL
    `;
    if (produtosValidos.length !== dto.produtoIds.length) {
      throw new NotFoundException('Um ou mais produtos não encontrados');
    }

    // Verifica conflito: algum dos produtos já está em outro ciclo ativo deste cliente
    const [conflito] = await this.sql`
      SELECT cr.id FROM ciclos_recompra cr
      JOIN ciclo_produtos cp ON cp.ciclo_id = cr.id
      WHERE cr.cliente_id = ${dto.clienteId}
        AND cp.produto_id = ANY(${dto.produtoIds})
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
        (loja_id, cliente_id, produto_id, intervalo_dias, quantidade, horario_envio, proxima_notificacao)
      VALUES (
        ${lojaId},
        ${dto.clienteId},
        ${dto.produtoIds[0]},
        ${dto.intervaloDias},
        ${dto.quantidade ?? null},
        ${horarioEnvio},
        NOW() + (${dto.intervaloDias} || ' days')::INTERVAL
      )
      RETURNING id
    `;

    // Insere todos os produtos na tabela de junção
    for (const produtoId of dto.produtoIds) {
      await this.sql`
        INSERT INTO ciclo_produtos (ciclo_id, produto_id) VALUES (${novoCiclo.id}, ${produtoId})
        ON CONFLICT DO NOTHING
      `;
    }

    void (async () => {
      try {
        const nomes = produtosValidos.map((p: any) => p.nome ?? p.id);
        void this.atividadeLog.registrar(lojaId, 'ciclo_criado',
          `Ciclo de ${formatarNomesProdutos(nomes)} criado para cliente (${dto.intervaloDias}d)`);
      } catch { /* silent */ }
    })();

    return this.buscarPorId(novoCiclo.id, lojaId);
  }

  // Atualiza intervalo, quantidade, ativo, horário e/ou produtos do ciclo
  async atualizar(id: string, dto: AtualizarCicloDto, lojaId: string) {
    const ciclo = await this.buscarPorId(id, lojaId);

    // Se fornecer novos produtos, valida e substitui
    if (dto.produtoIds !== undefined) {
      if (!dto.produtoIds.length) {
        throw new BadRequestException('Informe pelo menos um produto');
      }
      const produtosValidos = await this.sql`
        SELECT id FROM produtos
        WHERE id = ANY(${dto.produtoIds}) AND loja_id = ${lojaId} AND deleted_at IS NULL
      `;
      if (produtosValidos.length !== dto.produtoIds.length) {
        throw new NotFoundException('Um ou mais produtos não encontrados');
      }

      // Verifica conflito em outros ciclos deste cliente
      const [conflito] = await this.sql`
        SELECT cr.id FROM ciclos_recompra cr
        JOIN ciclo_produtos cp ON cp.ciclo_id = cr.id
        WHERE cr.cliente_id = ${ciclo.clienteId}
          AND cp.produto_id = ANY(${dto.produtoIds})
          AND cr.loja_id = ${lojaId}
          AND cr.id != ${id}
          AND cr.deleted_at IS NULL
      `;
      if (conflito) {
        throw new ConflictException(
          'Um ou mais produtos já fazem parte de outro ciclo ativo para este cliente',
        );
      }

      // Substitui os produtos na tabela de junção
      await this.sql`DELETE FROM ciclo_produtos WHERE ciclo_id = ${id}`;
      for (const produtoId of dto.produtoIds) {
        await this.sql`
          INSERT INTO ciclo_produtos (ciclo_id, produto_id) VALUES (${id}, ${produtoId})
          ON CONFLICT DO NOTHING
        `;
      }

      // Mantém produto_id legado sincronizado com o primeiro produto
      await this.sql`
        UPDATE ciclos_recompra SET produto_id = ${dto.produtoIds[0]}, updated_at = NOW()
        WHERE id = ${id} AND loja_id = ${lojaId}
      `;
    }

    const novaProximaNotificacao = dto.intervaloDias && dto.intervaloDias !== ciclo.intervaloDias
      ? this.sql`NOW() + (${dto.intervaloDias} || ' days')::INTERVAL`
      : this.sql`${ciclo.proximaNotificacao}`;

    const [atualizado] = await this.sql`
      UPDATE ciclos_recompra SET
        intervalo_dias      = COALESCE(${dto.intervaloDias ?? null}, intervalo_dias),
        quantidade          = COALESCE(${dto.quantidade ?? null}, quantidade),
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

  // Dispara lembrete imediato para um ciclo — ação manual, sem restrição de horário
  async enviarLembreteImediato(id: string, lojaId: string) {
    const [ciclo] = await this.sql`
      SELECT
        cr.id,
        cr.quantidade,
        c.nome  AS cliente_nome,
        c.telefone AS cliente_telefone,
        ARRAY(
          SELECT p.nome
          FROM ciclo_produtos cp
          JOIN produtos p ON p.id = cp.produto_id
          WHERE cp.ciclo_id = cr.id
          ORDER BY p.nome
        ) AS produto_nomes
      FROM ciclos_recompra cr
      JOIN clientes c ON c.id = cr.cliente_id
      WHERE cr.id = ${id} AND cr.loja_id = ${lojaId} AND cr.deleted_at IS NULL
    `;
    if (!ciclo) throw new NotFoundException('Ciclo não encontrado');

    const produtoNome = formatarNomesProdutos(ciclo.produtoNomes ?? []);

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
        quantidade:  ciclo.quantidade ?? undefined,
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
