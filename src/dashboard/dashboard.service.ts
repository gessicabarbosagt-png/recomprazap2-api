import { Injectable, Inject } from '@nestjs/common';
import { DATABASE_CLIENT } from '../database/database.module';

@Injectable()
export class DashboardService {
  constructor(@Inject(DATABASE_CLIENT) private readonly sql: any) {}

  // BRT = UTC-3 (fixo desde 2019, sem horário de verão)
  private brtIni(data: string): Date { return new Date(data + 'T00:00:00-03:00'); }
  private brtFim(data: string): Date { return new Date(data + 'T23:59:59.999-03:00'); }

  async serieTemporal(
    lojaId: string,
    diasAtras?: number,
    desde?: string,
    ate?: string,
  ) {
    let ini: Date;
    let fim: Date;
    let numDias: number;

    if (desde && ate) {
      ini = this.brtIni(desde);
      fim = this.brtFim(ate);
      numDias = Math.round((fim.getTime() - ini.getTime()) / 86_400_000);
    } else {
      const n = diasAtras ?? 30;
      fim = new Date();
      ini = new Date(fim.getTime() - n * 86_400_000);
      numDias = n;
    }

    // Período anterior: mesma duração imediatamente antes do período atual
    const iniAnterior = new Date(ini.getTime() - numDias * 86_400_000);
    const fimAnterior = new Date(ini.getTime() - 1);

    const agrupamento: 'dia' | 'semana' = numDias > 45 ? 'semana' : 'dia';

    // ── Série principal ──────────────────────────────────────────────────────
    const pontos = agrupamento === 'dia'
      ? await this.sql`
          WITH serie AS (
            SELECT generate_series(
              date_trunc('day', ${ini}::timestamptz AT TIME ZONE 'America/Sao_Paulo'),
              date_trunc('day', ${fim}::timestamptz AT TIME ZONE 'America/Sao_Paulo'),
              '1 day'::interval
            )::date AS dia
          ),
          dados AS (
            SELECT
              (confirmado_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
              COUNT(*)::int                           AS vendas,
              COALESCE(SUM(valor), 0)::numeric(12,2) AS receita
            FROM pedidos
            WHERE loja_id     = ${lojaId}
              AND deleted_at  IS NULL
              AND status_jornada = 'comprou'
              AND confirmado_em BETWEEN ${ini} AND ${fim}
            GROUP BY 1
          )
          SELECT s.dia::text, COALESCE(d.vendas, 0) AS vendas, COALESCE(d.receita, 0) AS receita
          FROM serie s
          LEFT JOIN dados d ON d.dia = s.dia
          ORDER BY s.dia
        `
      : await this.sql`
          WITH serie AS (
            SELECT generate_series(
              date_trunc('week', ${ini}::timestamptz AT TIME ZONE 'America/Sao_Paulo'),
              date_trunc('day',  ${fim}::timestamptz AT TIME ZONE 'America/Sao_Paulo'),
              '1 week'::interval
            )::date AS semana
          ),
          dados AS (
            SELECT
              date_trunc('week', confirmado_em AT TIME ZONE 'America/Sao_Paulo')::date AS semana,
              COUNT(*)::int                           AS vendas,
              COALESCE(SUM(valor), 0)::numeric(12,2) AS receita
            FROM pedidos
            WHERE loja_id     = ${lojaId}
              AND deleted_at  IS NULL
              AND status_jornada = 'comprou'
              AND confirmado_em BETWEEN ${ini} AND ${fim}
            GROUP BY 1
          )
          SELECT s.semana::text AS dia, COALESCE(d.vendas, 0) AS vendas, COALESCE(d.receita, 0) AS receita
          FROM serie s
          LEFT JOIN dados d ON d.semana = s.semana
          ORDER BY s.semana
        `;

    // ── Totais do período atual ───────────────────────────────────────────────
    const [totais] = await this.sql`
      SELECT
        COUNT(*)::int              AS total_vendas,
        COALESCE(SUM(valor), 0)   AS total_receita
      FROM pedidos
      WHERE loja_id       = ${lojaId}
        AND deleted_at    IS NULL
        AND status_jornada = 'comprou'
        AND confirmado_em  BETWEEN ${ini} AND ${fim}
    `;

    // ── Totais do período anterior (para variação %) ──────────────────────────
    const [totaisAnt] = await this.sql`
      SELECT
        COUNT(*)::int              AS total_vendas,
        COALESCE(SUM(valor), 0)   AS total_receita
      FROM pedidos
      WHERE loja_id       = ${lojaId}
        AND deleted_at    IS NULL
        AND status_jornada = 'comprou'
        AND confirmado_em  BETWEEN ${iniAnterior} AND ${fimAnterior}
    `;

    const calcVariacao = (atual: number, anterior: number) => {
      if (anterior === 0) return atual > 0 ? 100 : 0;
      return Math.round(((atual - anterior) / anterior) * 1000) / 10; // 1 decimal
    };

    const totalVendas   = Number(totais.totalVendas);
    const totalReceita  = Number(totais.totalReceita);
    const vendaAnt      = Number(totaisAnt.totalVendas);
    const receitaAnt    = Number(totaisAnt.totalReceita);

    return {
      agrupamento,
      pontos: pontos.map((p: any) => ({
        dia:     p.dia,
        vendas:  Number(p.vendas),
        receita: Number(p.receita),
      })),
      totalVendas,
      totalReceita,
      variacaoVendas:  calcVariacao(totalVendas,  vendaAnt),
      variacaoReceita: calcVariacao(totalReceita, receitaAnt),
    };
  }
}
