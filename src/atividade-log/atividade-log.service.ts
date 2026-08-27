import { Injectable, Inject, Logger } from '@nestjs/common';
import { DATABASE_CLIENT } from '../database/database.module';

@Injectable()
export class AtividadeLogService {
  private readonly logger = new Logger(AtividadeLogService.name);

  constructor(@Inject(DATABASE_CLIENT) private readonly sql: any) {}

  async registrar(lojaId: string, tipo: string, descricao: string) {
    try {
      await this.sql`
        INSERT INTO atividade_log (loja_id, tipo, descricao)
        VALUES (${lojaId}, ${tipo}, ${descricao})
      `;
    } catch (err: any) {
      // Nunca deixar falha de log quebrar a operação principal
      this.logger.error(`Erro ao registrar atividade [${tipo}]`, err?.message);
    }
  }

  async listarRecentes(lojaId: string, limite = 6) {
    return this.sql`
      SELECT id, tipo, descricao, criado_em
      FROM atividade_log
      WHERE loja_id = ${lojaId}
      ORDER BY criado_em DESC
      LIMIT ${limite}
    `;
  }
}
