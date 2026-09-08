import {
  Injectable, Inject, NotFoundException,
} from '@nestjs/common';
import { DATABASE_CLIENT } from '../database/database.module';

export interface CriarProdutoDto {
  nome: string;
  descricao?: string;
  preco?: number;
  especificacao?: string;
  estoque?: number | null;
}

export interface AtualizarProdutoDto {
  nome?: string;
  descricao?: string;
  preco?: number;
  especificacao?: string;
  estoque?: number | null;
  ativo?: boolean;
}

@Injectable()
export class ProdutosService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
  ) {}

  async listar(lojaId: string) {
    return this.sql`
      SELECT id, nome, descricao, preco, especificacao, estoque, ativo, created_at
      FROM produtos
      WHERE loja_id = ${lojaId} AND deleted_at IS NULL
      ORDER BY nome ASC
    `;
  }

  async buscarPorId(id: string, lojaId: string) {
    const [produto] = await this.sql`
      SELECT id, nome, descricao, preco, especificacao, estoque, ativo, created_at
      FROM produtos
      WHERE id = ${id} AND loja_id = ${lojaId} AND deleted_at IS NULL
    `;
    if (!produto) throw new NotFoundException('Produto não encontrado');
    return produto;
  }

  async criar(dto: CriarProdutoDto, lojaId: string) {
    const [novo] = await this.sql`
      INSERT INTO produtos (loja_id, nome, descricao, preco, especificacao, estoque)
      VALUES (
        ${lojaId},
        ${dto.nome},
        ${dto.descricao ?? null},
        ${dto.preco ?? null},
        ${dto.especificacao ?? null},
        ${dto.estoque ?? null}
      )
      RETURNING id, nome, descricao, preco, especificacao, estoque, ativo, created_at
    `;
    return novo;
  }

  async atualizar(id: string, dto: AtualizarProdutoDto, lojaId: string) {
    await this.buscarPorId(id, lojaId);
    const [atualizado] = await this.sql`
      UPDATE produtos SET
        nome          = COALESCE(${dto.nome ?? null}, nome),
        descricao     = COALESCE(${dto.descricao ?? null}, descricao),
        preco         = COALESCE(${dto.preco ?? null}, preco),
        especificacao = COALESCE(${dto.especificacao ?? null}, especificacao),
        estoque       = CASE
                          WHEN ${dto.estoque !== undefined} THEN ${dto.estoque ?? null}::numeric
                          ELSE estoque
                        END,
        ativo         = COALESCE(${dto.ativo ?? null}, ativo),
        updated_at    = NOW()
      WHERE id = ${id} AND loja_id = ${lojaId}
      RETURNING id, nome, descricao, preco, especificacao, estoque, ativo, created_at
    `;
    return atualizado;
  }

  async remover(id: string, lojaId: string) {
    await this.buscarPorId(id, lojaId);
    await this.sql`
      UPDATE produtos SET deleted_at = NOW(), updated_at = NOW()
      WHERE id = ${id} AND loja_id = ${lojaId}
    `;
  }

  async decrementarEstoque(produtoId: string, lojaId: string, quantidade: number) {
    await this.sql`
      UPDATE produtos
      SET estoque = GREATEST(0, estoque - ${quantidade}),
          updated_at = NOW()
      WHERE id = ${produtoId}
        AND loja_id = ${lojaId}
        AND estoque IS NOT NULL
    `;
  }
}
