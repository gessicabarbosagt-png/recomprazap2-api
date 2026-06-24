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

  // Lista todos os clientes ativos de uma loja
  async listar(lojaId: string) {
    const clientes = await this.sql`
      SELECT id, nome, telefone, email, ativo, consentimento_whatsapp, created_at
      FROM clientes
      WHERE loja_id = ${lojaId}
        AND deleted_at IS NULL
      ORDER BY nome ASC
    `;
    return clientes;
  }

  // Busca um cliente específico — garante que pertence à loja do usuário logado
  async buscarPorId(id: string, lojaId: string) {
    const [cliente] = await this.sql`
      SELECT id, nome, telefone, email, ativo, consentimento_whatsapp, created_at
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

  // Cria um novo cliente
  async criar(dto: CriarClienteDto, lojaId: string) {
    // Verifica se já existe cliente com esse telefone nessa loja
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
      INSERT INTO clientes (loja_id, nome, telefone, email, consentimento_whatsapp, consentimento_data)
      VALUES (
        ${lojaId},
        ${dto.nome},
        ${dto.telefone},
        ${dto.email ?? null},
        ${dto.consentimentoWhatsapp},
        ${dto.consentimentoWhatsapp ? new Date() : null}
      )
      RETURNING id, nome, telefone, email, ativo, consentimento_whatsapp, created_at
    `;

    return novoCliente;
  }

  // Atualiza dados de um cliente
  async atualizar(id: string, dto: AtualizarClienteDto, lojaId: string) {
    // Garante que o cliente existe e pertence a esta loja
    await this.buscarPorId(id, lojaId);

    const [atualizado] = await this.sql`
      UPDATE clientes
      SET
        nome = COALESCE(${dto.nome ?? null}, nome),
        telefone = COALESCE(${dto.telefone ?? null}, telefone),
        email = COALESCE(${dto.email ?? null}, email),
        ativo = COALESCE(${dto.ativo ?? null}, ativo),
        updated_at = NOW()
      WHERE id = ${id}
        AND loja_id = ${lojaId}
      RETURNING id, nome, telefone, email, ativo, consentimento_whatsapp, created_at
    `;

    return atualizado;
  }

  // Soft delete: não apaga o registro, apenas marca deleted_at
  async remover(id: string, lojaId: string) {
    await this.buscarPorId(id, lojaId);

    await this.sql`
      UPDATE clientes
      SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = ${id}
        AND loja_id = ${lojaId}
    `;
  }
}
