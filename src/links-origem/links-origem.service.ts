import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { DATABASE_CLIENT } from '../database/database.module';

function gerarSlug(rotulo: string): string {
  const base = rotulo
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 20);
  const sufixo = Math.random().toString(36).slice(2, 7);
  return `${base}-${sufixo}`;
}

@Injectable()
export class LinksOrigemService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
  ) {}

  async listar(lojaId: string) {
    return this.sql`
      SELECT id, slug, rotulo, mensagem_prefixo, cliques_total, criado_em
      FROM links_origem
      WHERE loja_id = ${lojaId}
      ORDER BY criado_em DESC
    `;
  }

  async criar(lojaId: string, dto: {
    rotulo: string;
    mensagemPrefixo?: string;
    codigoParaEmbutir?: string;
  }) {
    let slug = '';
    for (let i = 0; i < 5; i++) {
      const candidato = gerarSlug(dto.rotulo);
      const [existente] = await this.sql`SELECT id FROM links_origem WHERE slug = ${candidato}`;
      if (!existente) { slug = candidato; break; }
    }
    if (!slug) slug = gerarSlug(dto.rotulo + '-' + Date.now());

    const suffix = dto.codigoParaEmbutir ? ` #${dto.codigoParaEmbutir}` : '';
    const mensagem = dto.mensagemPrefixo
      ? dto.mensagemPrefixo
      : `Olá! Vim pelo ${dto.rotulo}.${suffix}`;

    const [link] = await this.sql`
      INSERT INTO links_origem (loja_id, slug, rotulo, mensagem_prefixo)
      VALUES (${lojaId}, ${slug}, ${dto.rotulo}, ${mensagem})
      RETURNING id, slug, rotulo, mensagem_prefixo, cliques_total, criado_em
    `;
    return link;
  }

  async atualizar(id: string, lojaId: string, dto: {
    rotulo?: string;
    mensagemPrefixo?: string;
  }) {
    const [existente] = await this.sql`
      SELECT id FROM links_origem WHERE id = ${id} AND loja_id = ${lojaId}
    `;
    if (!existente) throw new NotFoundException('Link não encontrado');

    const [atualizado] = await this.sql`
      UPDATE links_origem SET
        rotulo           = CASE WHEN ${dto.rotulo !== undefined} THEN ${dto.rotulo ?? null}
                                ELSE rotulo END,
        mensagem_prefixo = CASE WHEN ${dto.mensagemPrefixo !== undefined} THEN ${dto.mensagemPrefixo ?? null}
                                ELSE mensagem_prefixo END
      WHERE id = ${id} AND loja_id = ${lojaId}
      RETURNING id, slug, rotulo, mensagem_prefixo, cliques_total, criado_em
    `;
    return atualizado;
  }

  async remover(id: string, lojaId: string) {
    const [existente] = await this.sql`
      SELECT id FROM links_origem WHERE id = ${id} AND loja_id = ${lojaId}
    `;
    if (!existente) throw new NotFoundException('Link não encontrado');
    await this.sql`DELETE FROM links_origem WHERE id = ${id} AND loja_id = ${lojaId}`;
  }

  async resolverSlug(slug: string): Promise<{ redirectUrl: string } | null> {
    const [link] = await this.sql`
      SELECT lo.mensagem_prefixo, l.wa_numero
      FROM links_origem lo
      JOIN lojas l ON l.id = lo.loja_id
      WHERE lo.slug = ${slug} AND l.ativa = TRUE
    `;

    if (!link) return null;

    // Incrementa cliques (fire-and-forget)
    this.sql`
      UPDATE links_origem SET cliques_total = cliques_total + 1 WHERE slug = ${slug}
    `.catch(() => {});

    const numero = (link.waNumero ?? '').replace(/\D/g, '');
    if (!numero) return null;

    const texto = encodeURIComponent(link.mensagemPrefixo ?? '');
    return { redirectUrl: `https://wa.me/${numero}?text=${texto}` };
  }
}
