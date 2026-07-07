import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
} from '@nestjs/common';
import { DATABASE_CLIENT } from '../database/database.module';
import { useDatabaseAuthState } from './baileys-auth-state';
import {
  normalizarResposta,
  interpolarVariaveis,
  MENSAGEM_LEMBRETE_PADRAO,
  type OpcaoFluxo,
} from '../fluxo-conversa/fluxo-conversa.types';

const {
  makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  jidNormalizedUser,
} = require('@whiskeysockets/baileys');

const LOGGER_SILENCIOSO = {
  level: 'silent',
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => LOGGER_SILENCIOSO,
};

export type StatusConexao = 'desconectado' | 'aguardando' | 'conectado';

@Injectable()
export class WhatsappBaileysService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsappBaileysService.name);
  private socket: any = null;
  private qrAtual: string | null = null;
  private status: StatusConexao = 'desconectado';
  private reconectando = false;
  private readonly diagLogs: string[] = [];
  private msgsRecebidas = 0;
  private msgsIgnoradas = 0;
  private ultimaMsgEm: string | null = null;
  private readonly lidToPhone = new Map<string, string>();
  private readonly pendingSendJids = new Map<string, string>();

  private diag(msg: string) {
    const entry = `${new Date().toISOString()} ${msg}`;
    this.diagLogs.push(entry);
    if (this.diagLogs.length > 300) this.diagLogs.shift();
    this.logger.log(msg);
  }

  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
  ) {}

  async onModuleInit() {
    this.diag('[Baileys] onModuleInit — iniciando sessão…');
    await this.iniciarSessao().catch((err) => {
      this.diag(`[Baileys] FALHA CRÍTICA em onModuleInit: ${err?.message ?? err}`);
    });
  }

  async onModuleDestroy() {
    this.reconectando = false;
    this.socket?.end(undefined);
  }

  estaConectado(): boolean {
    return this.status === 'conectado';
  }

  // ----------------------------------------------------------------
  // LID → telefone: resolução em camadas
  // ----------------------------------------------------------------

  private async resolverLid(lid: string): Promise<string | null> {
    const cached = this.lidToPhone.get(lid);
    if (cached) return cached;

    if (this.socket?.signalRepository?.lidMapping) {
      try {
        const pnJid: string | null = await this.socket.signalRepository.lidMapping.getPNForLID(lid);
        if (pnJid) {
          const normalizado: string = jidNormalizedUser(pnJid) ?? pnJid;
          this.lidToPhone.set(lid, normalizado);
          return normalizado;
        }
      } catch (e: any) {
        this.diag(`[Baileys] getPNForLID(${lid}) falhou: ${e?.message}`);
      }
    }

    const [row] = await this.sql`SELECT phone_jid FROM whatsapp_lid_map WHERE lid = ${lid}`;
    if (row?.phoneJid) {
      this.lidToPhone.set(lid, row.phoneJid);
      return row.phoneJid;
    }

    return null;
  }

  private async salvarMapeamentoLid(lid: string, phoneJid: string, lojaId?: string | null): Promise<void> {
    this.lidToPhone.set(lid, phoneJid);

    if (this.socket?.signalRepository?.lidMapping) {
      await this.socket.signalRepository.lidMapping
        .storeLIDPNMappings([{ lid, pn: phoneJid }])
        .catch((e: any) => this.diag(`[Baileys] storeLIDPNMappings falhou: ${e?.message}`));
    }

    this.sql`
      INSERT INTO whatsapp_lid_map (lid, phone_jid, loja_id, updated_at)
      VALUES (${lid}, ${phoneJid}, ${lojaId ?? null}, NOW())
      ON CONFLICT (lid) DO UPDATE
        SET phone_jid = EXCLUDED.phone_jid,
            loja_id   = COALESCE(EXCLUDED.loja_id, whatsapp_lid_map.loja_id),
            updated_at = NOW()
    `.catch(() => {});
  }

  // ----------------------------------------------------------------
  // Plano C: mensagens com LID não resolvido
  // ----------------------------------------------------------------

  private async salvarMensagemPendente(lid: string, msg: any): Promise<void> {
    const msgRaw = JSON.stringify(msg);
    await this.sql`
      INSERT INTO whatsapp_mensagens_pendentes_lid (lid, msg_raw, recebido_em)
      VALUES (${lid}, ${msgRaw}, NOW())
    `.catch((e: any) => this.diag(`[Baileys] erro ao salvar msg pendente: ${e?.message}`));

    this.diag(`[Baileys] LID ${lid} sem mapeamento — mensagem salva como pendente`);

    for (const [delayMs, tentativa] of [[5_000, 1], [30_000, 2], [120_000, 3]] as const) {
      setTimeout(async () => {
        const resolvido = await this.resolverLid(lid).catch(() => null);
        if (resolvido) {
          this.diag(`[Baileys] LID ${lid} resolvido na tentativa ${tentativa} → ${resolvido}`);
          await this.processarPendentesDoLid(lid, resolvido).catch(() => {});
        } else {
          this.diag(`[Baileys] LID ${lid} ainda sem mapeamento (tentativa ${tentativa})`);
        }
      }, delayMs);
    }
  }

  private async processarPendentesDoLid(lid: string, phoneJid: string): Promise<void> {
    const pendentes = await this.sql`
      SELECT id, msg_raw
      FROM whatsapp_mensagens_pendentes_lid
      WHERE lid = ${lid} AND resolvido_em IS NULL
      ORDER BY recebido_em
    `;
    if (pendentes.length === 0) return;

    this.diag(`[Baileys] processando ${pendentes.length} mensagem(ns) pendente(s) de ${lid} → ${phoneJid}`);
    for (const p of pendentes) {
      try {
        const msg = JSON.parse(p.msgRaw);
        msg.key.remoteJid = phoneJid;
        await this.processarMensagemRecebida(msg);
        await this.sql`
          UPDATE whatsapp_mensagens_pendentes_lid
          SET resolvido_em = NOW(), tentativas = tentativas + 1
          WHERE id = ${p.id}
        `;
      } catch (e: any) {
        this.diag(`[Baileys] erro ao processar pendente ${p.id}: ${e?.message}`);
        await this.sql`
          UPDATE whatsapp_mensagens_pendentes_lid SET tentativas = tentativas + 1 WHERE id = ${p.id}
        `.catch(() => {});
      }
    }
  }

  private async tentarResolverPendentes(): Promise<void> {
    const lids = await this.sql`
      SELECT DISTINCT lid FROM whatsapp_mensagens_pendentes_lid WHERE resolvido_em IS NULL
    `;
    for (const { lid } of lids) {
      const resolvido = await this.resolverLid(lid).catch(() => null);
      if (resolvido) {
        await this.processarPendentesDoLid(lid, resolvido).catch(() => {});
      }
    }
  }

  // ----------------------------------------------------------------
  // Conexão Baileys
  // ----------------------------------------------------------------

  private async iniciarSessao() {
    this.reconectando = false;
    try {
      this.diag('[Baileys] carregando auth state do PostgreSQL…');
      const { state, saveCreds } = await useDatabaseAuthState(this.sql);
      this.diag('[Baileys] auth state carregado');

      let version: number[];
      try {
        const result = await fetchLatestBaileysVersion();
        version = result.version;
        this.diag(`[Baileys] versão obtida: ${version.join('.')}`);
      } catch (versionErr: any) {
        version = [2, 3000, 1023026504];
        this.diag(`[Baileys] fetchLatestBaileysVersion falhou (${versionErr?.message}) — fallback ${version.join('.')}`);
      }

      this.socket = makeWASocket({
        version,
        auth: state,
        browser: Browsers.macOS('Chrome'),
        printQRInTerminal: false,
        logger: LOGGER_SILENCIOSO,
        connectTimeoutMs: 60_000,
      });
      console.log('[SOCKET CREATED]', new Date().toISOString(), 'user:', this.socket.user?.id);
      this.diag('[Baileys] socket criado — aguardando eventos de conexão');

      this.socket.ev.on('creds.update', saveCreds);

      const lidRows = await this.sql`SELECT lid, phone_jid FROM whatsapp_lid_map`;
      for (const r of lidRows) {
        this.lidToPhone.set(r.lid, r.phoneJid);
      }
      if (lidRows.length > 0 && this.socket?.signalRepository?.lidMapping) {
        await this.socket.signalRepository.lidMapping
          .storeLIDPNMappings(lidRows.map((r: any) => ({ lid: r.lid, pn: r.phoneJid })))
          .catch(() => {});
      }
      this.diag(`[Baileys] LID map carregado do banco: ${lidRows.length} entradas`);

      const salvarLids = async (contacts: any[]) => {
        let novos = 0;
        for (const c of contacts) {
          if (c.lid && c.id) {
            await this.salvarMapeamentoLid(c.lid, c.id).catch(() => {});
            novos++;
          }
        }
        if (novos > 0 || contacts.length > 5) {
          const semLid = contacts.filter((c: any) => c.id && !c.lid).length;
          this.diag(`[Baileys] contacts sync: ${contacts.length} total, ${novos} com LID, ${semLid} sem LID`);
        }
      };
      this.socket.ev.on('contacts.upsert', salvarLids);
      this.socket.ev.on('contacts.update', salvarLids);

      console.log('[REGISTERING LISTENER]', 'connection.update', new Date().toISOString());
      this.socket.ev.on('connection.update', async (update: any) => {
        const { connection, lastDisconnect, qr } = update;
        this.diag(`[Baileys] connection.update: connection=${connection ?? 'n/a'} qr=${qr ? 'SIM' : 'não'}`);

        if (qr) {
          this.qrAtual = qr;
          this.status = 'aguardando';
          this.diag('[Baileys] QR Code gerado — aguardando escaneamento');
        }

        if (connection === 'open') {
          this.status = 'conectado';
          this.qrAtual = null;
          this.reconectando = false;
          this.diag('[Baileys] ✅ WhatsApp conectado');
          this.tentarResolverPendentes().catch(() => {});
        }

        if (connection === 'close') {
          this.status = 'desconectado';
          this.qrAtual = null;

          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const errorMsg = lastDisconnect?.error?.message ?? '';
          const deslogado = statusCode === DisconnectReason.loggedOut;

          this.diag(`[Baileys] conexão fechada — statusCode=${statusCode} deslogado=${deslogado} erro="${errorMsg}"`);

          if (deslogado) {
            this.reconectando = false;
            await this.sql`DELETE FROM baileys_auth_state`.catch((e: any) =>
              this.diag(`[Baileys] erro ao limpar auth state: ${e?.message}`),
            );
            setTimeout(() => this.iniciarSessao(), 3_000);
          } else if (!this.reconectando) {
            this.reconectando = true;
            this.diag('[Baileys] reconectando em 5s…');
            setTimeout(() => this.iniciarSessao(), 5_000);
          }
        }
      });

      console.log('[REGISTERING LISTENER]', 'messages.upsert', new Date().toISOString());
      this.socket.ev.on('messages.upsert', async ({ messages, type }: any) => {
        for (const m of (messages ?? [])) {
          console.log(`[RAW UPSERT] type=${type} remoteJid=${m.key?.remoteJid} fromMe=${m.key?.fromMe} hasMessage=${!!m.message} messageStubType=${m.messageStubType ?? 'none'}`);
        }
        this.diag(`[Baileys] messages.upsert: type=${type} count=${messages?.length ?? 0}`);

        for (const m of (messages ?? [])) {
          if (m.key?.fromMe && m.key?.remoteJid?.endsWith('@lid')) {
            const lid: string = m.key.remoteJid;
            const mid: string = m.key?.id ?? '';
            const phoneJid = mid ? this.pendingSendJids.get(mid) : undefined;
            if (phoneJid && !this.lidToPhone.has(lid)) {
              await this.salvarMapeamentoLid(lid, phoneJid);
              this.diag(`[Baileys] LID ${lid} → ${phoneJid} via eco (type=${type})`);
            }
          }
        }

        if (type !== 'notify') {
          this.msgsIgnoradas++;
          return;
        }

        for (const msg of messages) {
          const jid = msg.key?.remoteJid ?? '';
          const fromMe = msg.key?.fromMe ?? false;
          const hasMsg = !!msg.message;
          this.diag(`[Baileys] msg: jid=${jid} fromMe=${fromMe} hasMsg=${hasMsg}`);

          if (fromMe) {
            if (jid.endsWith('@lid')) {
              const msgId: string = msg.key?.id ?? '';
              const phoneJid = msgId ? this.pendingSendJids.get(msgId) : undefined;
              if (phoneJid && !this.lidToPhone.has(jid)) {
                await this.salvarMapeamentoLid(jid, phoneJid);
                this.diag(`[Baileys] LID ${jid} → ${phoneJid} via eco de envio (msgId=${msgId})`);
              }
            }
            this.msgsIgnoradas++;
            continue;
          }

          if (!hasMsg) {
            this.msgsIgnoradas++;
            continue;
          }

          await this.processarMensagemRecebida(msg).catch((err: any) =>
            this.diag(`[Baileys] erro ao processar mensagem: ${err?.message}`),
          );
        }
      });

    } catch (err: any) {
      this.diag(`[Baileys] ERRO em iniciarSessao: ${err?.message ?? err}`);
      throw err;
    }
  }

  // ----------------------------------------------------------------
  // Motor de mensagens recebidas
  // ----------------------------------------------------------------

  private async processarMensagemRecebida(msg: any) {
    let jid: string = msg.key.remoteJid ?? '';

    if (jid.endsWith('@lid')) {
      const resolvido = await this.resolverLid(jid);
      if (resolvido) {
        this.diag(`[Baileys] LID ${jid} resolvido → ${resolvido}`);
        jid = resolvido;
      } else {
        await this.salvarMensagemPendente(jid, msg);
        return;
      }
    }

    if (!jid.endsWith('@s.whatsapp.net')) {
      this.diag(`[Baileys] msg ignorada (grupo/status): jid=${jid}`);
      this.msgsIgnoradas++;
      return;
    }

    const numero = jid.replace('@s.whatsapp.net', '');
    const telefone = '+' + numero;

    const texto =
      msg.message?.conversation ??
      msg.message?.extendedTextMessage?.text ??
      msg.message?.buttonsResponseMessage?.selectedButtonId ??
      msg.message?.templateButtonReplyMessage?.selectedId ??
      '';

    const tipoMsg = Object.keys(msg.message ?? {})[0] ?? 'desconhecido';
    const whatsappMsgId: string = msg.key.id ?? '';

    this.diag(`[Baileys] processando msg de ${telefone} tipo=${tipoMsg} texto="${texto.slice(0, 60)}"`);
    this.msgsRecebidas++;
    this.ultimaMsgEm = new Date().toISOString();

    await this.registrarMensagem({
      telefone,
      direcao: 'recebida',
      conteudo: texto || `[${tipoMsg}]`,
      whatsappMsgId,
    });

    // Busca cliente para obter loja_id (necessário para sessão e fluxo)
    const [cliente] = await this.sql`
      SELECT id, loja_id FROM clientes
      WHERE telefone = ${telefone} AND deleted_at IS NULL
      LIMIT 1
    `;

    if (cliente) {
      await this.processarComFluxo(cliente.id, cliente.lojaId, texto, telefone);
    } else if (/^[123]$/.test(texto.trim())) {
      await this.processarRespostaPorTelefone(texto.trim(), telefone);
    }
  }

  /**
   * Motor de fluxo configurável.
   * Sessão ativa + fluxo ativo → engine de opcoes.
   * Caso contrário → comportamento hardcoded (busca último lembrete enviado).
   */
  private async processarComFluxo(clienteId: string, lojaId: string, texto: string, telefone: string) {
    const [sessao] = await this.sql`
      SELECT id, lembrete_id, fallbacks
      FROM sessao_conversa
      WHERE loja_id = ${lojaId} AND cliente_id = ${clienteId} AND expira_em > NOW()
      ORDER BY created_at DESC
      LIMIT 1
    `;

    const [fluxo] = await this.sql`
      SELECT mensagem_fallback, opcoes
      FROM fluxo_conversa
      WHERE loja_id = ${lojaId} AND ativo = true
      LIMIT 1
    `;

    // Sem sessão ou sem fluxo ativo → comportamento legado
    if (!sessao || !fluxo) {
      if (/^[123]$/.test(texto.trim())) {
        await this.processarRespostaPorTelefone(texto.trim(), telefone);
      }
      return;
    }

    const gatilho = normalizarResposta(texto);
    const opcoes = (fluxo.opcoes ?? []) as OpcaoFluxo[];
    const opcaoMatch = gatilho ? opcoes.find((o) => o.gatilho === gatilho) : null;

    if (!opcaoMatch) {
      const novosFallbacks = (sessao.fallbacks ?? 0) + 1;
      await this.sql`
        UPDATE sessao_conversa SET fallbacks = ${novosFallbacks}, updated_at = NOW() WHERE id = ${sessao.id}
      `;
      if (novosFallbacks <= 2) {
        await this.enviarMensagem(telefone, fluxo.mensagemFallback ?? fluxo.mensagem_fallback, lojaId);
        this.diag(`[Baileys] fallback ${novosFallbacks}/2 para ${telefone}`);
      } else {
        this.diag(`[Baileys] ${novosFallbacks} fallbacks para ${telefone} — parando respostas automáticas`);
      }
      return;
    }

    // Match encontrado!
    await this.enviarMensagem(telefone, opcaoMatch.mensagem_resposta, lojaId);

    if (opcaoMatch.acao !== 'nenhuma' && sessao.lembreteId) {
      await this.executarAcaoFluxo(opcaoMatch.acao, sessao.lembreteId, opcaoMatch.acao_params).catch((e: any) =>
        this.diag(`[Baileys] executarAcaoFluxo falhou: ${e?.message}`),
      );
    }

    await this.sql`UPDATE sessao_conversa SET expira_em = NOW(), updated_at = NOW() WHERE id = ${sessao.id}`;
    this.diag(`[Baileys] sessão ${sessao.id} encerrada após resposta "${gatilho}"`);
  }

  private async executarAcaoFluxo(acao: string, lembreteId: string, acoParams?: any): Promise<void> {
    const [lembrete] = await this.sql`
      SELECT l.id, l.loja_id, l.ciclo_id,
             cr.cliente_id, cr.produto_id, cr.quantidade
      FROM lembretes l
      JOIN ciclos_recompra cr ON cr.id = l.ciclo_id
      WHERE l.id = ${lembreteId}
    `;
    if (!lembrete) return;

    switch (acao) {
      case 'registrar_pedido':
        await this.sql`
          INSERT INTO pedidos (loja_id, lembrete_id, cliente_id, produto_id, quantidade, status)
          VALUES (${lembrete.lojaId}, ${lembrete.id}, ${lembrete.clienteId}, ${lembrete.produtoId}, ${lembrete.quantidade ?? 1}, 'pendente')
        `;
        await this.sql`UPDATE lembretes SET status='respondido', updated_at=NOW() WHERE id=${lembrete.id}`;
        break;

      case 'adiar_lembrete': {
        const dias = parseInt(String(acoParams?.dias ?? 7), 10);
        await this.sql`
          UPDATE ciclos_recompra
          SET proxima_notificacao = NOW() + (${dias} * INTERVAL '1 day'), updated_at = NOW()
          WHERE id = ${lembrete.cicloId}
        `;
        await this.sql`UPDATE lembretes SET status='respondido', updated_at=NOW() WHERE id=${lembrete.id}`;
        break;
      }

      case 'cancelar_ciclo': {
        const codigo = `RET-${Date.now().toString(36).toUpperCase()}`;
        await this.sql`
          INSERT INTO cupons (loja_id, cliente_id, codigo, desconto_pct, valido_ate)
          VALUES (${lembrete.lojaId}, ${lembrete.clienteId}, ${codigo}, 10.00, CURRENT_DATE + INTERVAL '30 days')
        `;
        await this.sql`UPDATE ciclos_recompra SET ativo=FALSE, updated_at=NOW() WHERE id=${lembrete.cicloId}`;
        await this.sql`UPDATE lembretes SET status='respondido', updated_at=NOW() WHERE id=${lembrete.id}`;
        break;
      }
    }
  }

  private async processarRespostaPorTelefone(opcao: string, telefone: string) {
    const acaoMap: Record<string, string> = { '1': 'pedir', '2': 'depois', '3': 'sair' };
    const acao = acaoMap[opcao];
    if (!acao) return;

    const [cliente] = await this.sql`
      SELECT id, nome FROM clientes WHERE telefone = ${telefone} AND deleted_at IS NULL LIMIT 1
    `;
    if (!cliente) return;

    const [lembrete] = await this.sql`
      SELECT l.id FROM lembretes l
      JOIN ciclos_recompra cr ON cr.id = l.ciclo_id
      WHERE cr.cliente_id = ${cliente.id} AND l.status = 'enviado'
      ORDER BY l.enviado_em DESC LIMIT 1
    `;
    if (!lembrete) return;

    await this.processarResposta(acao, lembrete.id, telefone);
  }

  private async processarResposta(acao: string, lembreteId: string, telefone: string) {
    const [lembrete] = await this.sql`
      SELECT l.id, l.loja_id, l.ciclo_id,
             cr.cliente_id, cr.produto_id, cr.quantidade
      FROM lembretes l
      JOIN ciclos_recompra cr ON cr.id = l.ciclo_id
      WHERE l.id = ${lembreteId}
    `;
    if (!lembrete) return;

    switch (acao) {
      case 'pedir':
        await this.sql`
          INSERT INTO pedidos (loja_id, lembrete_id, cliente_id, produto_id, quantidade, status)
          VALUES (${lembrete.lojaId}, ${lembrete.id}, ${lembrete.clienteId}, ${lembrete.produtoId}, ${lembrete.quantidade ?? 1}, 'pendente')
        `;
        await this.sql`UPDATE lembretes SET status='respondido', updated_at=NOW() WHERE id=${lembrete.id}`;
        break;

      case 'depois':
        await this.sql`
          UPDATE ciclos_recompra
          SET proxima_notificacao = NOW() + INTERVAL '7 days', updated_at = NOW()
          WHERE id = ${lembrete.cicloId}
        `;
        await this.sql`UPDATE lembretes SET status='respondido', updated_at=NOW() WHERE id=${lembrete.id}`;
        break;

      case 'sair': {
        const codigo = `RET-${Date.now().toString(36).toUpperCase()}`;
        await this.sql`
          INSERT INTO cupons (loja_id, cliente_id, codigo, desconto_pct, valido_ate)
          VALUES (${lembrete.lojaId}, ${lembrete.clienteId}, ${codigo}, 10.00, CURRENT_DATE + INTERVAL '30 days')
        `;
        await this.sql`UPDATE ciclos_recompra SET ativo=FALSE, updated_at=NOW() WHERE id=${lembrete.cicloId}`;
        await this.sql`UPDATE lembretes SET status='respondido', updated_at=NOW() WHERE id=${lembrete.id}`;
        break;
      }
    }
  }

  private async registrarMensagem(params: {
    telefone: string;
    direcao: 'recebida' | 'enviada';
    conteudo: string;
    whatsappMsgId?: string;
    lembreteId?: string | null;
  }): Promise<number> {
    try {
      const result = await this.sql`
        INSERT INTO mensagens_whatsapp
          (loja_id, lembrete_id, cliente_id, direcao, conteudo, whatsapp_message_id, tipo)
        SELECT
          c.loja_id,
          ${params.lembreteId ?? null},
          c.id,
          ${params.direcao}::mensagem_direcao,
          ${params.conteudo},
          ${params.whatsappMsgId ?? null},
          ${params.direcao === 'enviada' ? 'lembrete' : 'manual'}
        FROM clientes c
        WHERE c.telefone = ${params.telefone}
          AND c.deleted_at IS NULL
        LIMIT 1
      `;
      return result.count ?? 0;
    } catch (err: any) {
      this.diag(`[Baileys] erro ao registrar mensagem: ${err?.message}`);
      return -1;
    }
  }

  // ----------------------------------------------------------------
  // Envio de mensagens
  // ----------------------------------------------------------------

  async enviarLembrete(params: {
    telefone: string;
    clienteNome: string;
    produtoNome: string;
    quantidade?: number;
    unidade?: string;
    lembreteId: string;
    lojaId: string;
  }) {
    const { telefone, clienteNome, produtoNome, quantidade, unidade, lembreteId, lojaId } = params;

    // Carrega fluxo da loja para usar mensagem_lembrete configurada
    const [fluxo] = await this.sql`
      SELECT mensagem_lembrete FROM fluxo_conversa WHERE loja_id = ${lojaId} AND ativo = true LIMIT 1
    `;

    // Fallback encadeado: fluxo → lojas.modelo_mensagem → TEMPLATE_PADRAO
    let templateBase: string = fluxo?.mensagemLembrete ?? fluxo?.mensagem_lembrete;
    if (!templateBase) {
      const [loja] = await this.sql`SELECT modelo_mensagem FROM lojas WHERE id = ${lojaId}`;
      templateBase = loja?.modeloMensagem ?? MENSAGEM_LEMBRETE_PADRAO;
    }

    const qtdTexto = quantidade ? ` (${quantidade}${unidade ? ' ' + unidade : ''})` : '';

    const [loja] = await this.sql`SELECT nome FROM lojas WHERE id = ${lojaId}`;
    const texto = interpolarVariaveis(templateBase, {
      nome: clienteNome,
      produto: produtoNome,
      quantidade: qtdTexto,
      loja: loja?.nome ?? '',
    });

    await this.enviarMensagem(telefone, texto, lojaId);
    await this.registrarMensagem({ telefone, direcao: 'enviada', conteudo: texto, lembreteId });

    // Cria/renova sessão de conversa para capturar a resposta do cliente
    const [cliente] = await this.sql`
      SELECT id FROM clientes
      WHERE telefone = ${telefone} AND loja_id = ${lojaId} AND deleted_at IS NULL LIMIT 1
    `;
    if (cliente) {
      await this.sql`
        DELETE FROM sessao_conversa WHERE loja_id = ${lojaId} AND cliente_id = ${cliente.id} AND expira_em > NOW()
      `;
      await this.sql`
        INSERT INTO sessao_conversa (loja_id, cliente_id, lembrete_id, expira_em)
        VALUES (${lojaId}, ${cliente.id}, ${lembreteId}, NOW() + INTERVAL '48 hours')
      `;
      this.diag(`[Baileys] sessão criada para cliente ${cliente.id} (lembrete ${lembreteId})`);
    }
  }

  async enviarMensagem(telefone: string, texto: string, lojaId?: string) {
    if (!this.socket || this.status !== 'conectado') {
      throw new Error('WhatsApp não está conectado. Escaneie o QR Code em /configuracoes.');
    }

    const numero = telefone.replace('+', '').replace(/\D/g, '');
    const jid = `${numero}@s.whatsapp.net`;

    const enviado = await this.socket.sendMessage(jid, { text: texto });

    const sentJid: string = enviado?.key?.remoteJid ?? '';
    if (sentJid.endsWith('@lid')) {
      await this.salvarMapeamentoLid(sentJid, jid, lojaId);
      this.diag(`[Baileys] LID capturado ao enviar: ${sentJid} → ${jid}`);
    }

    const msgId: string = enviado?.key?.id ?? '';
    if (msgId) {
      this.pendingSendJids.set(msgId, jid);
      setTimeout(() => this.pendingSendJids.delete(msgId), 60_000);
    }

    this.logger.log(`Mensagem enviada para ${telefone}`);
  }

  // ----------------------------------------------------------------
  // API pública para o controller
  // ----------------------------------------------------------------

  getQrCode(): { qrcode: string | null; status: StatusConexao } {
    return { qrcode: this.qrAtual, status: this.status };
  }

  getDiagnostico() {
    return {
      status: this.status,
      qrcodePresente: !!this.qrAtual,
      socketAtivo: !!this.socket,
      reconectando: this.reconectando,
      msgsRecebidas: this.msgsRecebidas,
      msgsIgnoradas: this.msgsIgnoradas,
      ultimaMsgEm: this.ultimaMsgEm,
      logs: [...this.diagLogs],
    };
  }

  async desconectar() {
    this.reconectando = false;
    await this.socket?.logout();
    this.socket = null;
    this.qrAtual = null;
    this.status = 'desconectado';
  }

  async reconectar() {
    this.logger.log('[Baileys] reconectar() chamado manualmente');
    this.reconectando = false;
    this.socket?.end(undefined);
    this.socket = null;
    this.qrAtual = null;
    this.status = 'desconectado';
    await this.sql`DELETE FROM baileys_auth_state`.catch(() => {});
    await this.iniciarSessao();
  }
}
