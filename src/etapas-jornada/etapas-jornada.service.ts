import { Injectable, Inject, NotFoundException, BadRequestException } from '@nestjs/common';
import { DATABASE_CLIENT } from '../database/database.module';

@Injectable()
export class EtapasJornadaService {
  constructor(@Inject(DATABASE_CLIENT) private readonly sql: any) {}

  async listar(lojaId: string) {
    return this.sql`
      SELECT id, nome, ordem, tipo, ativo, created_at, updated_at
      FROM etapas_jornada
      WHERE loja_id = ${lojaId}
      ORDER BY
        CASE tipo
          WHEN 'intermediaria'      THEN 0
          WHEN 'final_comprou'      THEN 1
          WHEN 'final_nao_comprou'  THEN 2
        END ASC,
        ordem ASC
    `;
  }

  async criar(lojaId: string, dto: { nome: string }) {
    // Próxima ordem = max(ordem das intermediárias desta loja) + 1
    const [maxRow] = await this.sql`
      SELECT COALESCE(MAX(ordem), 0) AS max_ordem
      FROM etapas_jornada
      WHERE loja_id = ${lojaId} AND tipo = 'intermediaria'
    `;
    const novaOrdem = (maxRow?.maxOrdem ?? 0) + 1;

    const [etapa] = await this.sql`
      INSERT INTO etapas_jornada (loja_id, nome, ordem, tipo, ativo)
      VALUES (${lojaId}, ${dto.nome.trim()}, ${novaOrdem}, 'intermediaria', true)
      RETURNING id, nome, ordem, tipo, ativo, created_at, updated_at
    `;
    return etapa;
  }

  async atualizar(id: string, lojaId: string, dto: { nome?: string; ordem?: number; ativo?: boolean }) {
    const [existente] = await this.sql`
      SELECT id, tipo FROM etapas_jornada WHERE id = ${id} AND loja_id = ${lojaId}
    `;
    if (!existente) throw new NotFoundException('Etapa não encontrada');

    const isFinal = existente.tipo === 'final_comprou' || existente.tipo === 'final_nao_comprou';

    // Etapas finais só podem ter o nome alterado; não aceitam mudança de ordem nem desativação
    if (isFinal && (dto.ordem !== undefined || dto.ativo !== undefined)) {
      throw new BadRequestException(
        'Etapas finais (comprou / não comprou) só podem ter o nome alterado',
      );
    }

    const [atualizada] = await this.sql`
      UPDATE etapas_jornada SET
        nome       = COALESCE(${dto.nome?.trim() ?? null}, nome),
        ordem      = COALESCE(${dto.ordem ?? null}::int, ordem),
        ativo      = COALESCE(${dto.ativo ?? null}, ativo),
        updated_at = NOW()
      WHERE id = ${id} AND loja_id = ${lojaId}
      RETURNING id, nome, ordem, tipo, ativo, created_at, updated_at
    `;
    if (!atualizada) throw new NotFoundException('Etapa não encontrada');
    return atualizada;
  }

  async remover(id: string, lojaId: string) {
    const [existente] = await this.sql`
      SELECT id, tipo FROM etapas_jornada WHERE id = ${id} AND loja_id = ${lojaId}
    `;
    if (!existente) throw new NotFoundException('Etapa não encontrada');

    if (existente.tipo !== 'intermediaria') {
      throw new BadRequestException('Apenas etapas intermediárias podem ser removidas');
    }

    // Verifica se há pedidos com deleted_at IS NULL referenciando esta etapa
    const [usada] = await this.sql`
      SELECT id FROM pedidos
      WHERE etapa_id = ${id} AND deleted_at IS NULL
      LIMIT 1
    `;
    if (usada) {
      throw new BadRequestException(
        'Esta etapa possui pedidos ativos. Mova ou finalize os pedidos antes de remover.',
      );
    }

    await this.sql`DELETE FROM etapas_jornada WHERE id = ${id} AND loja_id = ${lojaId}`;
  }
}
