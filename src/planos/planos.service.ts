import {
  Injectable, Inject, NotFoundException, BadRequestException,
} from '@nestjs/common';
import { DATABASE_CLIENT } from '../database/database.module';
import { PagamentosService } from '../pagamentos/pagamentos.service';

@Injectable()
export class PlanosService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
    private readonly pagamentosService: PagamentosService,
  ) {}

  async listarCatalogo() {
    return this.sql`
      SELECT id, slug, nome, preco_mensal, limite_clientes, self_serve, features
      FROM planos_catalogo
      ORDER BY preco_mensal ASC
    `;
  }

  async buscarPlanoLoja(lojaId: string) {
    const [loja] = await this.sql`
      SELECT
        l.plano_slug,
        l.plano_pendente_slug,
        l.plano_pendente_efetiva_em,
        l.valor_mensalidade,
        l.proximo_vencimento,
        pc.nome             AS plano_nome,
        pc.limite_clientes  AS limite_clientes,
        pc.preco_mensal     AS plano_preco_mensal,
        pc.features         AS plano_features,
        (
          SELECT COUNT(*)::int FROM clientes
          WHERE loja_id = l.id AND deleted_at IS NULL AND ativo = TRUE
        ) AS total_clientes
      FROM lojas l
      LEFT JOIN planos_catalogo pc ON pc.slug = l.plano_slug
      WHERE l.id = ${lojaId} AND l.deleted_at IS NULL
    `;
    if (!loja) throw new NotFoundException('Loja não encontrada');

    let planoPendente = null;
    if (loja.planoPendenteSlug) {
      const [pp] = await this.sql`
        SELECT nome, preco_mensal FROM planos_catalogo WHERE slug = ${loja.planoPendenteSlug}
      `;
      planoPendente = {
        slug: loja.planoPendenteSlug,
        nome: pp?.nome ?? loja.planoPendenteSlug,
        precoMensal: pp?.precoMensal,
        efetivaDm: loja.planoPendenteEfetivaEm,
      };
    }

    return {
      planoSlug: loja.planoSlug ?? null,
      planoNome: loja.planoSlug ? (loja.planoNome ?? loja.planoSlug) : 'Plano customizado',
      limiteClientes: loja.limiteClientes ?? null,
      totalClientes: loja.totalClientes,
      valorMensalidade: loja.valorMensalidade,
      planoPendente,
    };
  }

  async fazerUpgrade(lojaId: string, planoSlug: string) {
    const [plano] = await this.sql`
      SELECT slug, nome, preco_mensal, self_serve, limite_clientes
      FROM planos_catalogo WHERE slug = ${planoSlug}
    `;
    if (!plano) throw new NotFoundException('Plano não encontrado');
    if (!plano.selfServe) {
      throw new BadRequestException('Este plano requer contato com a equipe');
    }

    await this.sql`
      UPDATE lojas SET
        plano_slug               = ${planoSlug},
        valor_mensalidade        = ${Number(plano.precoMensal)},
        plano_pendente_slug      = NULL,
        plano_pendente_efetiva_em = NULL,
        updated_at               = NOW()
      WHERE id = ${lojaId} AND deleted_at IS NULL
    `;

    // Atualiza valor na assinatura MP para o próximo ciclo (fire-and-forget)
    this.pagamentosService.atualizarValorPreapproval(lojaId, Number(plano.precoMensal)).catch(() => {});

    return { planoSlug, nome: plano.nome, precoMensal: Number(plano.precoMensal) };
  }

  async agendarDowngrade(lojaId: string, planoSlug: string) {
    const [plano] = await this.sql`
      SELECT slug, nome, limite_clientes, self_serve
      FROM planos_catalogo WHERE slug = ${planoSlug}
    `;
    if (!plano) throw new NotFoundException('Plano não encontrado');
    if (!plano.selfServe) {
      throw new BadRequestException('Este plano requer contato com a equipe');
    }

    const [loja] = await this.sql`
      SELECT proximo_vencimento,
             (SELECT COUNT(*)::int FROM clientes
              WHERE loja_id = ${lojaId} AND deleted_at IS NULL AND ativo = TRUE) AS total_clientes
      FROM lojas WHERE id = ${lojaId} AND deleted_at IS NULL
    `;
    if (!loja) throw new NotFoundException('Loja não encontrada');

    if (loja.totalClientes > plano.limiteClientes) {
      throw new BadRequestException(
        `Você tem ${loja.totalClientes} clientes cadastrados e o plano ${plano.nome} permite até ${plano.limiteClientes}. Remova clientes ou escolha outro plano.`,
      );
    }

    // Downgrade efetivo no próximo vencimento; se não há vencimento definido, usa hoje + 30 dias
    let efetivaDm: string;
    if (loja.proximoVencimento) {
      efetivaDm = typeof loja.proximoVencimento === 'string'
        ? loja.proximoVencimento.slice(0, 10)
        : new Date(loja.proximoVencimento).toISOString().slice(0, 10);
    } else {
      const d = new Date();
      d.setDate(d.getDate() + 30);
      efetivaDm = d.toISOString().slice(0, 10);
    }

    await this.sql`
      UPDATE lojas SET
        plano_pendente_slug      = ${planoSlug},
        plano_pendente_efetiva_em = ${efetivaDm},
        updated_at               = NOW()
      WHERE id = ${lojaId} AND deleted_at IS NULL
    `;

    return { planoSlug, nome: plano.nome, efetivaDm };
  }

  async cancelarDowngradePendente(lojaId: string) {
    await this.sql`
      UPDATE lojas SET
        plano_pendente_slug      = NULL,
        plano_pendente_efetiva_em = NULL,
        updated_at               = NOW()
      WHERE id = ${lojaId} AND deleted_at IS NULL
    `;
    return { ok: true };
  }

  // Chamado pelo cron diário — aplica downgrades cujo prazo chegou
  async aplicarDowngradesPendentes(): Promise<number> {
    const lojas = await this.sql`
      SELECT id, plano_pendente_slug
      FROM lojas
      WHERE plano_pendente_slug IS NOT NULL
        AND plano_pendente_efetiva_em <= CURRENT_DATE
        AND deleted_at IS NULL
    `;

    let aplicados = 0;
    for (const loja of lojas) {
      const [check] = await this.sql`
        SELECT pc.preco_mensal, pc.limite_clientes,
               (SELECT COUNT(*)::int FROM clientes
                WHERE loja_id = ${loja.id} AND deleted_at IS NULL AND ativo = TRUE) AS total_clientes
        FROM planos_catalogo pc
        WHERE pc.slug = ${loja.planoPendenteSlug}
      `;

      if (!check || check.totalClientes > check.limiteClientes) {
        // Cancela pendente — loja excede limite do plano destino
        await this.sql`
          UPDATE lojas SET plano_pendente_slug = NULL, plano_pendente_efetiva_em = NULL, updated_at = NOW()
          WHERE id = ${loja.id}
        `;
        continue;
      }

      await this.sql`
        UPDATE lojas SET
          plano_slug               = ${loja.planoPendenteSlug},
          valor_mensalidade        = ${Number(check.precoMensal)},
          plano_pendente_slug      = NULL,
          plano_pendente_efetiva_em = NULL,
          updated_at               = NOW()
        WHERE id = ${loja.id}
      `;
      aplicados++;
    }
    return aplicados;
  }
}
