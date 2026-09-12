import {
  Injectable, Inject, NotFoundException, ConflictException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { DATABASE_CLIENT } from '../database/database.module';
import { EmailService } from '../email/email.service';

type AcaoAuditoria =
  | 'criar_loja'
  | 'desativar_loja'
  | 'ativar_loja'
  | 'resetar_senha_lojista'
  | 'alterar_plano'
  | 'excluir_loja';

function gerarTokenRedefinicao(): { rawToken: string; tokenHash: string; expiraEm: Date } {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiraEm = new Date(Date.now() + 60 * 60 * 1000);
  return { rawToken, tokenHash, expiraEm };
}

const MENSAGEM_LEMBRETE_PADRAO =
  `Oi, {nome}! 👋\n\nJá está na hora de repor *{produto}*{quantidade}. Posso te ajudar?\n\nResponda:\n1️⃣ *1* — Quero pedir\n2️⃣ *2* — Me avise depois\n3️⃣ *3* — Não quero mais`;

const MENSAGEM_FALLBACK_PADRAO =
  `Não entendi sua resposta. Por favor, responda com *1*, *2* ou *3* conforme as opções enviadas anteriormente.`;

const OPCOES_PADRAO = JSON.stringify([
  { gatilho: '1', rotulo: 'Quero pedir', mensagem_resposta: 'Ótimo! Seu pedido foi registrado. Em breve entraremos em contato. 😊', acao: 'registrar_pedido' },
  { gatilho: '2', rotulo: 'Me avise depois', mensagem_resposta: 'Tudo bem! Vou te avisar de novo em 7 dias. 📅', acao: 'adiar_lembrete', acao_params: { dias: 7 } },
  { gatilho: '3', rotulo: 'Não quero mais', mensagem_resposta: 'Entendido! Pausei os lembretes desse produto. Se precisar de algo, estamos aqui. 😊', acao: 'cancelar_ciclo' },
]);

@Injectable()
export class AdminService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
    private readonly emailService: EmailService,
  ) {}

  // ----------------------------------------------------------------
  // Resumo de saúde — cards da home /admin
  // ----------------------------------------------------------------
  async resumoSaude() {
    const [resumo] = await this.sql`
      SELECT
        COUNT(*) FILTER (WHERE ativa = TRUE AND status_assinatura != 'cancelada')  AS total_ativas,
        COUNT(*) FILTER (WHERE ativa = TRUE AND wa_status = 'desconectado')         AS wa_desconectados,
        COUNT(*) FILTER (WHERE status_assinatura = 'inadimplente' AND ativa = TRUE) AS inadimplentes
      FROM lojas
      WHERE deleted_at IS NULL
    `;

    const [{ lembretes_hoje }] = await this.sql`
      SELECT COUNT(*)::int AS lembretes_hoje
      FROM lembretes
      WHERE created_at >= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date::timestamptz AT TIME ZONE 'America/Sao_Paulo'
    `;

    const lojasCriticas = await this.sql`
      SELECT id, nome, wa_status, wa_atualizado_em, status_assinatura
      FROM lojas
      WHERE deleted_at IS NULL
        AND ativa = TRUE
        AND (wa_status = 'desconectado' OR status_assinatura = 'inadimplente')
      ORDER BY nome
    `;

    return {
      totalAtivas: Number(resumo.totalAtivas),
      waDesconectados: Number(resumo.waDesconectados),
      inadimplentes: Number(resumo.inadimplentes),
      lembretesHoje: lembretes_hoje,
      lojasCriticas,
    };
  }

  // ----------------------------------------------------------------
  // Lista todas as lojas com estatísticas
  // ----------------------------------------------------------------
  async listarLojas() {
    return this.sql`
      SELECT
        l.id,
        l.nome,
        l.email,
        l.slug,
        l.ativa,
        l.plano,
        l.status_assinatura,
        l.valor_mensalidade,
        l.proximo_vencimento,
        l.wa_status,
        l.wa_atualizado_em,
        l.created_at,
        (
          SELECT COUNT(*)::int
          FROM lembretes lm
          WHERE lm.loja_id = l.id
            AND lm.created_at >= NOW() - INTERVAL '7 days'
        ) AS lembretes_7d,
        (
          SELECT MAX(lm.created_at)
          FROM lembretes lm
          WHERE lm.loja_id = l.id
        ) AS ultima_atividade
      FROM lojas l
      WHERE l.deleted_at IS NULL
      ORDER BY l.nome
    `;
  }

  // ----------------------------------------------------------------
  // Detalhe de uma loja: dados + usuários
  // ----------------------------------------------------------------
  async detalharLoja(id: string) {
    const [loja] = await this.sql`
      SELECT
        id, nome, email, slug, ativa, plano, plano_slug,
        status_assinatura, valor_mensalidade, proximo_vencimento,
        wa_status, wa_atualizado_em, horario_abertura, horario_fechamento,
        retry_automatico, horas_para_retry, created_at
      FROM lojas
      WHERE id = ${id} AND deleted_at IS NULL
    `;
    if (!loja) throw new NotFoundException('Loja não encontrada');

    const usuarios = await this.sql`
      SELECT id, nome, email, perfil, ativo, created_at
      FROM usuarios
      WHERE loja_id = ${id} AND deleted_at IS NULL
      ORDER BY nome
    `;

    return { ...loja, usuarios };
  }

  // ----------------------------------------------------------------
  // Grava registro imutável de ação administrativa na tabela audit_log
  // ----------------------------------------------------------------
  private async gravarAuditoria(
    adminId: string,
    acao: AcaoAuditoria,
    lojaAfetadaId: string | null,
    detalhes?: Record<string, unknown>,
  ) {
    await this.sql`
      INSERT INTO audit_log (admin_id, acao, loja_afetada_id, detalhes)
      VALUES (
        ${adminId},
        ${acao},
        ${lojaAfetadaId},
        ${detalhes ? JSON.stringify(detalhes) : null}
      )
    `.catch(() => {});
  }

  // ----------------------------------------------------------------
  // Cria loja + usuário lojista com senha temporária + seeds padrão
  // ----------------------------------------------------------------
  async criarLoja(dto: {
    lojaNome: string;
    lojaEmail: string;
    usuarioNome: string;
    usuarioEmail: string;
  }, adminId: string) {
    const existeEmail = await this.sql`
      SELECT id FROM lojas WHERE email = ${dto.lojaEmail} AND deleted_at IS NULL
    `;
    if (existeEmail.length) throw new ConflictException('Email de loja já cadastrado');

    const existeUsuario = await this.sql`
      SELECT id FROM usuarios WHERE email = ${dto.usuarioEmail} AND deleted_at IS NULL
    `;
    if (existeUsuario.length) throw new ConflictException('Email de usuário já cadastrado');

    const slug = dto.lojaNome
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60)
      + '-' + Date.now().toString(36);

    // Senha não é definida pelo admin — placeholder nunca compartilhado.
    // O lojista define a própria senha pelo link enviado por e-mail.
    const placeholderHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 4);
    const { rawToken, tokenHash, expiraEm } = gerarTokenRedefinicao();

    const [loja] = await this.sql`
      INSERT INTO lojas (nome, email, slug)
      VALUES (${dto.lojaNome}, ${dto.lojaEmail}, ${slug})
      RETURNING id, nome, email, slug
    `;

    const [usuario] = await this.sql`
      INSERT INTO usuarios (loja_id, nome, email, senha_hash, perfil, role, token_redefinicao, token_expira_em)
      VALUES (${loja.id}, ${dto.usuarioNome}, ${dto.usuarioEmail}, ${placeholderHash}, 'dono', 'lojista', ${tokenHash}, ${expiraEm})
      RETURNING id, nome, email, perfil
    `;

    await this.rodarSeedsPorLoja(loja.id);

    await this.gravarAuditoria(adminId, 'criar_loja', loja.id, {
      loja_nome: dto.lojaNome,
      usuario_email: dto.usuarioEmail,
    });

    // Envia e-mail de "primeiro acesso" — lojista define a própria senha pelo link
    await this.emailService.enviarDefinicaoSenhaInicial(dto.usuarioEmail, rawToken, dto.usuarioNome);

    return { loja, usuario, emailEnviado: true };
  }

  // ----------------------------------------------------------------
  // Atualiza dados de assinatura da loja
  // ----------------------------------------------------------------
  async atualizarLoja(id: string, dto: {
    plano?: string;
    planoSlug?: string | null;
    statusAssinatura?: string;
    valorMensalidade?: number | null;
    proximoVencimento?: string | null;
  }, adminId: string) {
    const [atualizado] = await this.sql`
      UPDATE lojas
      SET
        plano               = COALESCE(${dto.plano ?? null}, plano),
        plano_slug          = ${dto.planoSlug !== undefined ? (dto.planoSlug || null) : this.sql`plano_slug`},
        status_assinatura   = COALESCE(${dto.statusAssinatura ?? null}, status_assinatura),
        valor_mensalidade   = ${dto.valorMensalidade !== undefined ? dto.valorMensalidade : this.sql`valor_mensalidade`},
        proximo_vencimento  = ${dto.proximoVencimento !== undefined ? dto.proximoVencimento : this.sql`proximo_vencimento`},
        updated_at          = NOW()
      WHERE id = ${id} AND deleted_at IS NULL
      RETURNING id, nome, plano, plano_slug, status_assinatura, valor_mensalidade, proximo_vencimento
    `;
    if (!atualizado) throw new NotFoundException('Loja não encontrada');

    await this.gravarAuditoria(adminId, 'alterar_plano', id, {
      plano: dto.plano,
      status_assinatura: dto.statusAssinatura,
      valor_mensalidade: dto.valorMensalidade,
      proximo_vencimento: dto.proximoVencimento,
    });

    return atualizado;
  }

  // ----------------------------------------------------------------
  // Ativa ou desativa uma loja
  // ----------------------------------------------------------------
  async ativarDesativar(id: string, ativa: boolean, adminId: string) {
    const [atualizado] = await this.sql`
      UPDATE lojas SET ativa = ${ativa}, updated_at = NOW()
      WHERE id = ${id} AND deleted_at IS NULL
      RETURNING id, nome, ativa
    `;
    if (!atualizado) throw new NotFoundException('Loja não encontrada');

    await this.gravarAuditoria(adminId, ativa ? 'ativar_loja' : 'desativar_loja', id);

    return atualizado;
  }

  // ----------------------------------------------------------------
  // Gera nova senha temporária para um usuário
  // ----------------------------------------------------------------
  async resetarSenha(lojaId: string, userId: string, adminId: string) {
    const [usuario] = await this.sql`
      SELECT id, email, nome FROM usuarios
      WHERE id = ${userId} AND loja_id = ${lojaId} AND deleted_at IS NULL
    `;
    if (!usuario) throw new NotFoundException('Usuário não encontrado');

    const { rawToken, tokenHash, expiraEm } = gerarTokenRedefinicao();

    await this.sql`
      UPDATE usuarios
      SET token_redefinicao = ${tokenHash}, token_expira_em = ${expiraEm}, updated_at = NOW()
      WHERE id = ${userId}
    `;

    await this.gravarAuditoria(adminId, 'resetar_senha_lojista', lojaId, { usuario_id: userId });

    await this.emailService.enviarRedefinicaoSenha(usuario.email, rawToken);

    return { emailEnviado: true, usuarioEmail: usuario.email };
  }

  // ----------------------------------------------------------------
  // Seeds padrão para uma loja recém-criada
  // ----------------------------------------------------------------
  private async rodarSeedsPorLoja(lojaId: string) {
    await this.sql`
      INSERT INTO fluxo_conversa (loja_id, mensagem_lembrete, mensagem_fallback, opcoes)
      VALUES (${lojaId}, ${MENSAGEM_LEMBRETE_PADRAO}, ${MENSAGEM_FALLBACK_PADRAO}, ${OPCOES_PADRAO}::jsonb)
      ON CONFLICT (loja_id) DO NOTHING
    `.catch(() => {});

    const origensValues = [
      ['instagram', 'Instagram'],
      ['insta',     'Instagram'],
      ['google',    'Google'],
      ['face',      'Facebook'],
      ['site',      'Site'],
      ['indicacao', 'Indicação'],
    ] as const;

    for (const [codigo, rotulo] of origensValues) {
      await this.sql`
        INSERT INTO codigos_origem (loja_id, codigo, rotulo)
        VALUES (${lojaId}, ${codigo}, ${rotulo})
        ON CONFLICT DO NOTHING
      `.catch(() => {});
    }

    await this.sql`
      INSERT INTO gatilhos_compra (loja_id, frase, ativo)
      VALUES (${lojaId}, 'Obrigado pela compra', false)
      ON CONFLICT DO NOTHING
    `.catch(() => {});

    const etapas = [
      ['Aguardando retorno', 1, 'intermediaria'],
      ['Orçamento enviado',  2, 'intermediaria'],
      ['Comprou',            3, 'final_comprou'],
      ['Não comprou',        4, 'final_nao_comprou'],
    ] as const;

    for (const [nome, ordem, tipo] of etapas) {
      await this.sql`
        INSERT INTO etapas_jornada (loja_id, nome, ordem, tipo)
        VALUES (${lojaId}, ${nome}, ${ordem}, ${tipo})
        ON CONFLICT DO NOTHING
      `.catch(() => {});
    }
  }

  // ----------------------------------------------------------------
  // Soft-delete de loja (admin): desativa loja + usuários + audit
  // ----------------------------------------------------------------
  async excluirLoja(id: string, adminId: string) {
    const [loja] = await this.sql`
      SELECT id, nome FROM lojas WHERE id = ${id} AND deleted_at IS NULL
    `;
    if (!loja) throw new NotFoundException('Loja não encontrada');

    // postgres.camel transforma total_clientes → totalClientes no resultado
    const [{ totalClientes }] = await this.sql`
      SELECT COUNT(*) AS total_clientes FROM clientes
      WHERE loja_id = ${id} AND deleted_at IS NULL
    `;
    const [{ totalPedidos }] = await this.sql`
      SELECT COUNT(*) AS total_pedidos FROM pedidos
      WHERE loja_id = ${id} AND deleted_at IS NULL
    `;

    await this.gravarAuditoria(adminId, 'excluir_loja', id, {
      nome: loja.nome,
      total_clientes: Number(totalClientes),
      total_pedidos: Number(totalPedidos),
    });

    await this.sql`
      UPDATE lojas SET ativa = FALSE, deleted_at = NOW(), updated_at = NOW()
      WHERE id = ${id}
    `;
    await this.sql`
      UPDATE usuarios SET ativo = FALSE, deleted_at = NOW(), updated_at = NOW()
      WHERE loja_id = ${id}
    `;

    return {
      ok: true,
      nome: loja.nome,
      totalClientes: Number(totalClientes),
      totalPedidos: Number(totalPedidos),
    };
  }

  // ----------------------------------------------------------------
  // Retorna planos_catalogo com stripe_price_id (verificação de config)
  // ----------------------------------------------------------------
  async listarPlanos() {
    return this.sql`
      SELECT slug, nome, preco_mensal, stripe_price_id
      FROM planos_catalogo
      ORDER BY preco_mensal
    `;
  }
}
