import {
  Injectable, Inject, NotFoundException, ConflictException,
} from '@nestjs/common';
import { DATABASE_CLIENT } from '../database/database.module';
import { CriarClienteDto } from './dto/criar-cliente.dto';
import { AtualizarClienteDto } from './dto/atualizar-cliente.dto';

@Injectable()
export class ClientesService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
  ) {}

  async listar(lojaId: string) {
    return this.sql`
      SELECT id, nome, telefone, email, ativo, consentimento_whatsapp,
             origem_lead, origem_detalhe, whatsapp_nome, created_at
      FROM clientes
      WHERE loja_id = ${lojaId}
        AND deleted_at IS NULL
      ORDER BY nome ASC
    `;
  }

  async buscarPorId(id: string, lojaId: string) {
    const [cliente] = await this.sql`
      SELECT id, nome, telefone, email, ativo, consentimento_whatsapp,
             origem_lead, origem_detalhe, whatsapp_nome, created_at
      FROM clientes
      WHERE id = ${id}
        AND loja_id = ${lojaId}
        AND deleted_at IS NULL
    `;

    if (!cliente) {
      throw new NotFoundException('Cliente não encontrado');
    }

    return cliente;
  }

  async criar(dto: CriarClienteDto, lojaId: string) {
    const [existente] = await this.sql`
      SELECT id FROM clientes
      WHERE telefone = ${dto.telefone}
        AND loja_id = ${lojaId}
        AND deleted_at IS NULL
    `;

    if (existente) {
      throw new ConflictException(
        'Já existe um cliente com esse número de telefone nesta loja',
      );
    }

    const [novoCliente] = await this.sql`
      INSERT INTO clientes
        (loja_id, nome, telefone, email, consentimento_whatsapp, consentimento_data,
         origem_lead, origem_detalhe)
      VALUES (
        ${lojaId},
        ${dto.nome},
        ${dto.telefone},
        ${dto.email ?? null},
        ${dto.consentimentoWhatsapp},
        ${dto.consentimentoWhatsapp ? new Date() : null},
        ${dto.origemLead ?? null},
        ${dto.origemDetalhe ?? null}
      )
      RETURNING id, nome, telefone, email, ativo, consentimento_whatsapp,
                origem_lead, origem_detalhe, whatsapp_nome, created_at
    `;

    return novoCliente;
  }

  async atualizar(id: string, dto: AtualizarClienteDto, lojaId: string) {
    await this.buscarPorId(id, lojaId);

    const [atualizado] = await this.sql`
      UPDATE clientes
      SET
        nome           = COALESCE(${dto.nome ?? null}, nome),
        telefone       = COALESCE(${dto.telefone ?? null}, telefone),
        email          = COALESCE(${dto.email ?? null}, email),
        ativo          = COALESCE(${dto.ativo ?? null}, ativo),
        origem_lead    = COALESCE(${dto.origemLead ?? null}, origem_lead),
        origem_detalhe = COALESCE(${dto.origemDetalhe ?? null}, origem_detalhe),
        updated_at     = NOW()
      WHERE id = ${id}
        AND loja_id = ${lojaId}
      RETURNING id, nome, telefone, email, ativo, consentimento_whatsapp,
                origem_lead, origem_detalhe, whatsapp_nome, created_at
    `;

    return atualizado;
  }

  async remover(id: string, lojaId: string) {
    await this.buscarPorId(id, lojaId);

    await this.sql`
      UPDATE clientes
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = ${id}
        AND loja_id = ${lojaId}
    `;
  }

  // Contagem de clientes novos agrupados por origem no período
  async origensResumo(lojaId: string, diasAtras: number) {
    return this.sql`
      SELECT
        COALESCE(origem_lead, 'sem_origem') AS origem,
        COUNT(*)::int                        AS total
      FROM clientes
      WHERE loja_id   = ${lojaId}
        AND deleted_at IS NULL
        AND created_at >= NOW() - (${diasAtras} || ' days')::INTERVAL
      GROUP BY origem_lead
      ORDER BY total DESC
    `;
  }
}
