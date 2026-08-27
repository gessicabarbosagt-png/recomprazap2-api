import {
  Injectable, Inject, NotFoundException, ConflictException, BadRequestException,
} from '@nestjs/common';
import { DATABASE_CLIENT } from '../database/database.module';
import { CriarClienteDto } from './dto/criar-cliente.dto';
import { AtualizarClienteDto } from './dto/atualizar-cliente.dto';
import { AtividadeLogService } from '../atividade-log/atividade-log.service';

@Injectable()
export class ClientesService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
    private readonly atividadeLog: AtividadeLogService,
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

    void this.atividadeLog.registrar(lojaId, 'cliente_criado', `Cliente ${dto.nome} cadastrado`);

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

  // BRT é fixamente UTC-3 desde 2019
  private brtIni(data: string): Date { return new Date(data + 'T00:00:00-03:00'); }
  private brtFim(data: string): Date { return new Date(data + 'T23:59:59.999-03:00'); }

  async origensResumo(lojaId: string, diasAtras?: number, desde?: string, ate?: string) {
    if (desde && ate) {
      const ini = this.brtIni(desde), fim = this.brtFim(ate);
      return this.sql`
        SELECT
          COALESCE(origem_lead, 'sem_origem') AS origem,
          COUNT(*)::int                        AS total
        FROM clientes
        WHERE loja_id   = ${lojaId}
          AND deleted_at IS NULL
          AND created_at >= ${ini} AND created_at <= ${fim}
        GROUP BY origem_lead
        ORDER BY total DESC
      `;
    }
    const n = diasAtras ?? 30;
    return this.sql`
      SELECT
        COALESCE(origem_lead, 'sem_origem') AS origem,
        COUNT(*)::int                        AS total
      FROM clientes
      WHERE loja_id   = ${lojaId}
        AND deleted_at IS NULL
        AND created_at >= NOW() - (${n} || ' days')::INTERVAL
      GROUP BY origem_lead
      ORDER BY total DESC
    `;
  }

  // ── Exportar CSV ───────────────────────────────────────────────────────────

  async exportarCsv(lojaId: string): Promise<string> {
    const clientes = await this.sql`
      SELECT nome, telefone, email, origem_lead, created_at
      FROM clientes
      WHERE loja_id = ${lojaId}
        AND deleted_at IS NULL
      ORDER BY nome ASC
    `;

    const header = 'nome,telefone,email,origem_lead,criado_em';
    const rows = (clientes as any[]).map(c => [
      this.csvCell(c.nome),
      this.csvCell(c.telefone),
      this.csvCell(c.email),
      this.csvCell(c.origem_lead),
      c.created_at ? new Date(c.created_at).toISOString().slice(0, 10) : '',
    ].join(','));

    return [header, ...rows].join('\n');
  }

  // Formata célula CSV: escapa aspas, envolve em aspas se necessário,
  // e neutraliza fórmulas Excel (CSV injection)
  private csvCell(v: unknown): string {
    if (v == null) return '';
    const s = String(v);
    // Neutraliza formula injection: prefixar com ' se começa com =,+,-,@
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    if (/[,"\n\r]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
    return safe;
  }

  // ── Importar CSV ───────────────────────────────────────────────────────────

  async importarCsv(arquivo: Express.Multer.File, lojaId: string) {
    // Validação de tamanho (multer já rejeita acima de 2MB, mas checamos por segurança)
    if (arquivo.size > 2 * 1024 * 1024) {
      throw new BadRequestException('Arquivo muito grande (máx 2 MB)');
    }

    // Validação de extensão
    if (!arquivo.originalname.toLowerCase().endsWith('.csv')) {
      throw new BadRequestException('Apenas arquivos .csv são aceitos');
    }

    // Detecção de arquivo binário disfarçado: conta bytes não-imprimíveis
    const amostra = arquivo.buffer.slice(0, 1024);
    let naoImprimiveis = 0;
    for (const byte of amostra) {
      if (byte < 9 || (byte > 13 && byte < 32)) naoImprimiveis++;
    }
    if (amostra.length > 0 && naoImprimiveis / amostra.length > 0.1) {
      throw new BadRequestException('Arquivo parece ser binário, não um CSV de texto');
    }

    // Parse do CSV
    const { headers, rows } = this.parseCsvBuffer(arquivo.buffer);

    // Mapeamento flexível de cabeçalhos
    const idxDe = (opcoes: string[]) => {
      for (const op of opcoes) {
        const i = headers.indexOf(op);
        if (i >= 0) return i;
      }
      return -1;
    };

    const nomeIdx     = idxDe(['nome', 'name', 'cliente', 'client']);
    const telefoneIdx = idxDe(['telefone', 'phone', 'celular', 'fone', 'whatsapp', 'tel', 'numero']);
    const emailIdx    = idxDe(['email', 'e-mail', 'e_mail', 'mail']);

    if (telefoneIdx === -1) {
      throw new BadRequestException(
        'Coluna de telefone não encontrada. Use o cabeçalho: telefone, phone, celular ou whatsapp',
      );
    }

    let importados = 0;
    let atualizados = 0;
    const erros: { linha: number; motivo: string }[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const linhaNum = i + 2; // +1 offset de array, +1 pelo cabeçalho

      const rawTelefone = row[telefoneIdx]?.trim() ?? '';
      const rawNome     = nomeIdx >= 0 ? (row[nomeIdx]?.trim() ?? '') : '';
      const rawEmail    = emailIdx >= 0 ? (row[emailIdx]?.trim() ?? '') : '';

      if (!rawTelefone) {
        erros.push({ linha: linhaNum, motivo: 'Telefone vazio (campo obrigatório)' });
        continue;
      }

      const telefone = this.normalizarTelefone(rawTelefone);
      if (!telefone) {
        erros.push({ linha: linhaNum, motivo: `Telefone inválido: "${rawTelefone}"` });
        continue;
      }

      // Sanitiza campos de texto contra CSV injection
      const nome  = this.sanitizarInjection(rawNome) || telefone;
      const email = rawEmail ? this.sanitizarInjection(rawEmail) : null;

      const [existente] = await this.sql`
        SELECT id FROM clientes
        WHERE telefone = ${telefone}
          AND loja_id  = ${lojaId}
          AND deleted_at IS NULL
      `;

      if (existente) {
        await this.sql`
          UPDATE clientes
          SET
            nome       = CASE WHEN ${nome} <> '' THEN ${nome} ELSE nome END,
            email      = COALESCE(${email}, email),
            updated_at = NOW()
          WHERE id      = ${existente.id}
            AND loja_id = ${lojaId}
        `;
        atualizados++;
      } else {
        await this.sql`
          INSERT INTO clientes (loja_id, nome, telefone, email, origem_lead, consentimento_whatsapp)
          VALUES (${lojaId}, ${nome}, ${telefone}, ${email}, 'importado', false)
        `;
        importados++;
      }
    }

    return {
      importados,
      atualizados,
      erros,
      totalLinhas: rows.length,
    };
  }

  // Converte número de telefone para E.164 (+5511999999999)
  private normalizarTelefone(raw: string): string | null {
    const trimmed = raw.trim();
    const digits = trimmed.replace(/\D/g, '');
    if (!digits) return null;

    // Já no formato E.164 (+...)
    if (trimmed.startsWith('+')) {
      return digits.length >= 8 && digits.length <= 15 ? '+' + digits : null;
    }

    // Números brasileiros sem código de país: 10 (DDD+8) ou 11 (DDD+9) dígitos
    if (digits.length === 10 || digits.length === 11) return '+55' + digits;

    // Com código 55 na frente: 12 ou 13 dígitos
    if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) {
      return '+' + digits;
    }

    return null;
  }

  // Remove caracteres de fórmula do início de um campo de texto
  private sanitizarInjection(v: string): string {
    return v.replace(/^[=+\-@]+/, '').trim();
  }

  // Parser CSV simples: suporta aspas, escape de aspas duplas e delimitador , ou ;
  private parseCsvBuffer(buffer: Buffer): { headers: string[]; rows: string[][] } {
    const text = buffer.toString('utf-8')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');

    const linhas = text.split('\n').filter(l => l.trim().length > 0);
    if (linhas.length === 0) throw new BadRequestException('Arquivo CSV vazio');

    // Detecta delimitador pela contagem no cabeçalho
    const cabecalho = linhas[0];
    const delimitador = cabecalho.split(';').length > cabecalho.split(',').length ? ';' : ',';

    const parseRow = (linha: string): string[] => {
      const campos: string[] = [];
      let atual = '';
      let aspas = false;
      for (let i = 0; i < linha.length; i++) {
        const ch = linha[i];
        if (ch === '"') {
          if (aspas && linha[i + 1] === '"') { atual += '"'; i++; }
          else aspas = !aspas;
        } else if (ch === delimitador && !aspas) {
          campos.push(atual.trim());
          atual = '';
        } else {
          atual += ch;
        }
      }
      campos.push(atual.trim());
      return campos;
    };

    return {
      headers: parseRow(linhas[0]).map(h => h.toLowerCase().replace(/['"]/g, '').trim()),
      rows: linhas.slice(1).map(parseRow),
    };
  }
}
