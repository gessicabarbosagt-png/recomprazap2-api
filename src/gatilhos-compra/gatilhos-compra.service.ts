import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { DATABASE_CLIENT } from '../database/database.module';

@Injectable()
export class GatilhosCompraService {
  constructor(@Inject(DATABASE_CLIENT) private readonly sql: any) {}

  async listar(lojaId: string) {
    return this.sql`
      SELECT id, frase, ativo, created_at
      FROM gatilhos_compra
      WHERE loja_id = ${lojaId}
      ORDER BY created_at ASC
    `;
  }

  async criar(lojaId: string, dto: { frase: string }) {
    const [g] = await this.sql`
      INSERT INTO gatilhos_compra (loja_id, frase, ativo)
      VALUES (${lojaId}, ${dto.frase.trim()}, false)
      RETURNING id, frase, ativo, created_at
    `;
    return g;
  }

  async atualizar(id: string, lojaId: string, dto: { frase?: string; ativo?: boolean }) {
    const [g] = await this.sql`
      UPDATE gatilhos_compra SET
        frase = COALESCE(${dto.frase?.trim() ?? null}, frase),
        ativo = COALESCE(${dto.ativo ?? null}, ativo)
      WHERE id = ${id} AND loja_id = ${lojaId}
      RETURNING id, frase, ativo, created_at
    `;
    if (!g) throw new NotFoundException('Gatilho não encontrado');
    return g;
  }

  async remover(id: string, lojaId: string) {
    const [existente] = await this.sql`
      SELECT id FROM gatilhos_compra WHERE id = ${id} AND loja_id = ${lojaId}
    `;
    if (!existente) throw new NotFoundException('Gatilho não encontrado');
    await this.sql`DELETE FROM gatilhos_compra WHERE id = ${id} AND loja_id = ${lojaId}`;
  }
}
