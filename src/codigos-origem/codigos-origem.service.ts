import {
  Injectable, Inject, NotFoundException, ConflictException,
} from '@nestjs/common';
import { DATABASE_CLIENT } from '../database/database.module';
import { CriarCodigoDto } from './dto/criar-codigo.dto';

@Injectable()
export class CodigosOrigemService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
  ) {}

  async listar(lojaId: string) {
    return this.sql`
      SELECT id, codigo, rotulo, created_at
      FROM codigos_origem
      WHERE loja_id = ${lojaId}
      ORDER BY rotulo ASC
    `;
  }

  async criar(dto: CriarCodigoDto, lojaId: string) {
    const [existente] = await this.sql`
      SELECT id FROM codigos_origem
      WHERE loja_id = ${lojaId} AND codigo = ${dto.codigo}
    `;
    if (existente) {
      throw new ConflictException(`Código #${dto.codigo} já existe`);
    }

    const [novo] = await this.sql`
      INSERT INTO codigos_origem (loja_id, codigo, rotulo)
      VALUES (${lojaId}, ${dto.codigo}, ${dto.rotulo})
      RETURNING id, codigo, rotulo, created_at
    `;
    return novo;
  }

  async atualizar(id: string, dto: Partial<CriarCodigoDto>, lojaId: string) {
    const [existente] = await this.sql`
      SELECT id FROM codigos_origem WHERE id = ${id} AND loja_id = ${lojaId}
    `;
    if (!existente) throw new NotFoundException('Código não encontrado');

    const [atualizado] = await this.sql`
      UPDATE codigos_origem
      SET
        codigo = COALESCE(${dto.codigo ?? null}, codigo),
        rotulo = COALESCE(${dto.rotulo ?? null}, rotulo)
      WHERE id = ${id} AND loja_id = ${lojaId}
      RETURNING id, codigo, rotulo, created_at
    `;
    return atualizado;
  }

  async remover(id: string, lojaId: string) {
    const [existente] = await this.sql`
      SELECT id FROM codigos_origem WHERE id = ${id} AND loja_id = ${lojaId}
    `;
    if (!existente) throw new NotFoundException('Código não encontrado');

    await this.sql`DELETE FROM codigos_origem WHERE id = ${id} AND loja_id = ${lojaId}`;
  }
}
