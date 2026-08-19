import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
} from '@nestjs/common';
import { DATABASE_CLIENT } from '../database/database.module';
import { MetaAdsService } from '../meta-ads/meta-ads.service';
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

// Detecta intenção de adiamento de lembrete na mensagem do cliente.
// Retorna { dias, precisaRevisao } ou null se não houver padrão reconhecido.
function detectarIntencaoAdiamento(texto: string): { dias: number; precisaRevisao: boolean } | null {
  const norm = normalizarTexto(texto);

  // Numérico: "X dias", "em X dias", "daqui a X dias", etc.
  const numMatch = norm.match(/(\d+)\s+dias?/);
  if (numMatch) return { dias: parseInt(numMatch[1], 10), precisaRevisao: false };

  // Períodos nomeados
  if (/amanha/.test(norm)) return { dias: 1, precisaRevisao: false };
  if (/semana\s+que\s+vem|proxima\s+semana/.test(norm)) return { dias: 7, precisaRevisao: false };
  if (/mes\s+que\s+vem|proximo\s+mes/.test(norm)) return { dias: 30, precisaRevisao: false };

  // Vagos → assume 7 dias + marca para revisão do lojista
  if (/agora\s+nao|nao\s+agora|(?:^|\s)depois(?:\s|$)|mais\s+tarde/.test(norm)) {
    return { dias: 7, precisaRevisao: true };
  }

  return null;
}

const TIPOS_PROTOCOLO = new Set([
  'messageContextInfo',
  'protocolMessage',
  'senderKeyDistributionMessage',
  'pollUpdateMessage',
  'appStateSyncKeyRequest',
  'appStateSyncKeyShare',
]);

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

export function normalizarTexto(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

export type StatusConexao = 'desconectado' | 'aguardando' | 'conectado';

// Estado isolado por loja — cada loja tem seu próprio socket Baileys
interface LojaSession {
  lojaId: string;
  socket: any | null;
  status: StatusConexao;
  qrAtual: string | null;
  reconectando: boolean;
  sessaoSeq: number;
  diagLogs: string[];
  msgsRecebidas: number;
  msgsIgnoradas: number;
  ultimaMsgEm: string | null;
  ultimaMsgIndividualEm: string | null;
  lidToPhone: Map<string, string>;
  pendingSendJids: Map<string, string>;
}

@Injectable()
export class WhatsappBaileysService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsappBaileysService.name);
  private readonly sessions = new Map<string, LojaSession>();
  private readonly iniciando = new Set<string>();

  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
    private readonly metaAdsService: MetaAdsService,
  ) {}

  // Inicia sessões para todas as lojas ativas ao subir o serviço
  async onModuleInit() {
    const lojas = await this.sql`SELECT id FROM lojas WHERE ativa = TRUE`;
    for (const loja of lojas) {
      await this.iniciarSessao(loja.id).catch((err) => {
        this.logger.error(`[Baileys] FALHA ao iniciar sessão para loja ${loja.id}: ${err?.message ?? err}`);
      });
    }

    // Health check a cada 3 minutos: detecta WebSocket fechado silenciosamente
    setInterval(() => this._verificarSaudeConexoes(), 3 * 60 * 1000);

    // Segunda camada a cada 1 hora: detecta phantom connection (WS open mas sem msgs individuais)
    // Aguarda 30 min após startup antes da primeira verificação para não disparar falso positivo
    setTimeout(() => {
      this._verificarFalhaSilenciosa().catch(() => {});
      setInterval(() => this._verificarFalhaSilenciosa().catch(() => {}), 60 * 60 * 1000);
    }, 30 * 60 * 1000);
  }

  async onModuleDestroy() {
    for (const session of this.sessions.values()) {
      session.reconectando = false;
      session.socket?.end(undefined);
    }
  }

  private _verificarSaudeConexoes() {
    for (const [lojaId, session] of this.sessions) {
      if (session.status !== 'conectado' || !session.socket) continue;

      // readyState: 0=CONNECTING 1=OPEN 2=CLOSING 3=CLOSED
      const wsState: number | undefined = session.socket.ws?.readyState;
      if (wsState !== undefined && wsState !== 1) {
        this.diag(session, `[HEALTH] WebSocket readyState=${wsState} mas status=conectado — reiniciando sessão`);
        session.reconectando = false;
        this.iniciarSessao(lojaId).catch((err: any) =>
          this.diag(session, `[HEALTH] erro ao reiniciar: ${err?.message}`),
        );
      }
    }
  }

  private async _verificarFalhaSilenciosa() {
    // Identifica lojas que mostram conectado no DB mas não recebem msgs individuais há >6h
    // Requer wa_ultima_msg_individual_em persistido + histórico de atividade (>=3 msgs recebidas em 30 dias)
    const candidatos = await this.sql`
      SELECT l.id, l.nome
      FROM lojas l
      WHERE l.ativa = TRUE
        AND l.deleted_at IS NULL
        AND l.wa_status = 'conectado'
        AND l.wa_ultima_msg_individual_em IS NOT NULL
        AND l.wa_ultima_msg_individual_em < NOW() - INTERVAL '6 hours'
        AND (
          SELECT COUNT(*) FROM mensagens_whatsapp m
          WHERE m.loja_id = l.id
            AND m.direcao = 'recebida'
            AND m.created_at > NOW() - INTERVAL '30 days'
        ) >= 3
    `.catch(() => [] as any[]);

    for (const loja of candidatos) {
      this.logger.warn(`[HEALTH] possível falha silenciosa detectada para loja ${loja.id} (${loja.nome})`);
      await this.sql`
        INSERT INTO notificacoes_admin (loja_id, mensagem, tipo)
        VALUES (
          ${loja.id},
          'Possível falha silenciosa no inbox: WhatsApp aparece conectado mas pode não estar recebendo mensagens individuais. Acesse Configurações e reconecte via QR se necessário.',
          'falha_silenciosa_inbox'
        )
        ON CONFLICT DO NOTHING
      `.catch(() => {});
    }

    // Também verifica sessões em memória (captura lojas sem wa_ultima_msg_individual_em ainda)
    for (const [, session] of this.sessions) {
      if (session.status !== 'conectado') continue;
      if (!session.ultimaMsgIndividualEm) continue;
      const seisHoras = 6 * 60 * 60 * 1000;
      const semMsgHa = Date.now() - new Date(session.ultimaMsgIndividualEm).getTime();
      if (semMsgHa > seisHoras) {
        this.diag(session, `[HEALTH] sem msgs individuais há ${Math.round(semMsgHa / 3600000)}h — possível falha silenciosa`);
      }
    }
  }

  // ----------------------------------------------------------------
  // Gerenciamento de sessões
  // ----------------------------------------------------------------

  private ensureSession(lojaId: string): LojaSession {
    if (!this.sessions.has(lojaId)) {
      this.sessions.set(lojaId, {
        lojaId,
        socket: null,
        status: 'desconectado',
        qrAtual: null,
        reconectando: false,
        sessaoSeq: 0,
        diagLogs: [],
        msgsRecebidas: 0,
        msgsIgnoradas: 0,
        ultimaMsgEm: null,
        ultimaMsgIndividualEm: null,
        lidToPhone: new Map(),
        pendingSendJids: new Map(),
      });
    }
    return this.sessions.get(lojaId)!;
  }

  private diag(session: LojaSession, msg: string) {
    const entry = `${new Date().toISOString()} ${msg}`;
    session.diagLogs.push(entry);
    if (session.diagLogs.length > 300) session.diagLogs.shift();
    this.logger.log(msg);
  }

  // ----------------------------------------------------------------
  // LID → telefone: resolução por sessão de loja
  // ----------------------------------------------------------------

  private async resolverLid(lid: string, session: LojaSession): Promise<string | null> {
    const cached = session.lidToPhone.get(lid);
    if (cached) return cached;

    if (session.socket?.signalRepository?.lidMapping) {
      try {
        const pnJid: string | null = await session.socket.signalRepository.lidMapping.getPNForLID(lid);
        if (pnJid) {
          const normalizado: string = jidNormalizedUser(pnJid) ?? pnJid;
          session.lidToPhone.set(lid, normalizado);
          return normalizado;
        }
      } catch (e: any) {
        this.diag(session, `[Baileys] getPNForLID(${lid}) falhou: ${e?.message}`);
      }
    }

    const [row] = await this.sql`
      SELECT phone_jid FROM whatsapp_lid_map
      WHERE lid = ${lid} AND loja_id = ${session.lojaId}
    `;
    if (row?.phoneJid) {
      session.lidToPhone.set(lid, row.phoneJid);
      return row.phoneJid;
    }

    return null;
  }

  private async salvarMapeamentoLid(lid: string, phoneJid: string, session: LojaSession): Promise<void> {
    session.lidToPhone.set(lid, phoneJid);

    if (session.socket?.signalRepository?.lidMapping) {
      await session.socket.signalRepository.lidMapping
        .storeLIDPNMappings([{ lid, pn: phoneJid }])
        .catch((e: any) => this.diag(session, `[Baileys] storeLIDPNMappings falhou: ${e?.message}`));
    }

    this.sql`
      INSERT INTO whatsapp_lid_map (lid, phone_jid, loja_id, updated_at)
      VALUES (${lid}, ${phoneJid}, ${session.lojaId}, NOW())
      ON CONFLICT (lid) DO UPDATE
        SET phone_jid = EXCLUDED.phone_jid,
            loja_id   = COALESCE(EXCLUDED.loja_id, whatsapp_lid_map.loja_id),
            updated_at = NOW()
    `.catch(() => {});
  }

  // ----------------------------------------------------------------
  // Plano C: mensagens com LID não resolvido
  // ----------------------------------------------------------------

  private async salvarMensagemPendente(lid: string, msg: any, session: LojaSession): Promise<void> {
    const msgRaw = JSON.stringify(msg);
    await this.sql`
      INSERT INTO whatsapp_mensagens_pendentes_lid (lid, msg_raw, recebido_em, loja_id)
      VALUES (${lid}, ${msgRaw}, NOW(), ${session.lojaId})
    `.catch((e: any) => this.diag(session, `[Baileys] erro ao salvar msg pendente: ${e?.message}`));

    this.diag(session, `[Baileys] LID ${lid} sem mapeamento — mensagem salva como pendente`);

    for (const [delayMs, tentativa] of [[5_000, 1], [30_000, 2], [120_000, 3]] as const) {
      setTimeout(async () => {
        const resolvido = await this.resolverLid(lid, session).catch(() => null);
        if (resolvido) {
          this.diag(session, `[Baileys] LID ${lid} resolvido na tentativa ${tentativa} → ${resolvido}`);
          await this.processarPendentesDoLid(lid, resolvido, session).catch(() => {});
        } else {
          this.diag(session, `[Baileys] LID ${lid} ainda sem mapeamento (tentativa ${tentativa})`);
        }
      }, delayMs);
    }
  }

  private async processarPendentesDoLid(lid: string, phoneJid: string, session: LojaSession): Promise<void> {
    const pendentes = await this.sql`
      SELECT id, msg_raw
      FROM whatsapp_mensagens_pendentes_lid
      WHERE lid = ${lid} AND loja_id = ${session.lojaId} AND resolvido_em IS NULL
      ORDER BY recebido_em
    `;
    if (pendentes.length === 0) return;

    this.diag(session, `[Baileys] processando ${pendentes.length} mensagem(ns) pendente(s) de ${lid} → ${phoneJid}`);
    for (const p of pendentes) {
      try {
        const msg = JSON.parse(p.msgRaw);
        msg.key.remoteJid = phoneJid;
        await this.processarMensagemRecebida(msg, session);
        await this.sql`
          UPDATE whatsapp_mensagens_pendentes_lid
          SET resolvido_em = NOW(), tentativas = tentativas + 1
          WHERE id = ${p.id}
        `;
      } catch (e: any) {
        this.diag(session, `[Baileys] erro ao processar pendente ${p.id}: ${e?.message}`);
        await this.sql`
          UPDATE whatsapp_mensagens_pendentes_lid SET tentativas = tentativas + 1 WHERE id = ${p.id}
        `.catch(() => {});
      }
    }
  }

  private async tentarResolverPendentes(session: LojaSession): Promise<void> {
    const lids = await this.sql`
      SELECT DISTINCT lid FROM whatsapp_mensagens_pendentes_lid
      WHERE resolvido_em IS NULL AND loja_id = ${session.lojaId}
    `;
    for (const { lid } of lids) {
      const resolvido = await this.resolverLid(lid, session).catch(() => null);
      if (resolvido) {
        await this.processarPendentesDoLid(lid, resolvido, session).catch(() => {});
      }
    }
  }

  // ----------------------------------------------------------------
  // Conexão Baileys — uma sessão por loja
  // ----------------------------------------------------------------

  private async iniciarSessao(lojaId: string) {
    const session = this.ensureSession(lojaId);

    // Incrementa o número de sequência ANTES de qualquer coisa: qualquer saveCreds
    // ainda em voo de uma sessão anterior vai detectar que sua seq está desatualizada
    // e descartar a escrita — fechando a race condition residual de saveCreds concorrentes.
    const meSeq = ++session.sessaoSeq;

    // Remove listeners do socket anterior ANTES de criar o novo. Sem isso, o
    // connection=close que o WA envia ao socket antigo (quando o novo assume)
    // dispara outro iniciarSessao em cascata, corrompendo o auth state via
    // gravações concorrentes de saveCreds.
    const socketAntigo = session.socket;
    if (socketAntigo) {
      socketAntigo.ev.removeAllListeners();
      session.socket = null;
      socketAntigo.end(undefined);
    }

    session.reconectando = false;

    try {
      this.diag(session, `[Baileys] carregando auth state para loja ${lojaId}… (seq=${meSeq})`);
      const { state, saveCreds: _saveCreds } = await useDatabaseAuthState(this.sql, lojaId);

      // Guarda com verificação de seq: descarta escrita se outra sessão mais recente já tomou o controle
      const saveCreds = async () => {
        if (session.sessaoSeq !== meSeq) {
          this.diag(session, `[Baileys] saveCreds descartado (seq desatualizada: minha=${meSeq} atual=${session.sessaoSeq})`);
          return;
        }
        return _saveCreds();
      };
      this.diag(session, '[Baileys] auth state carregado');

      let version: number[];
      try {
        const result = await fetchLatestBaileysVersion();
        version = result.version;
        this.diag(session, `[Baileys] versão obtida: ${version.join('.')}`);
      } catch (versionErr: any) {
        version = [2, 3000, 1023026504];
        this.diag(session, `[Baileys] fetchLatestBaileysVersion falhou (${versionErr?.message}) — fallback ${version.join('.')}`);
      }

      session.socket = makeWASocket({
        version,
        auth: state,
        browser: ['RecompraZap', 'Chrome', '1.0.0'],
        printQRInTerminal: false,
        logger: LOGGER_SILENCIOSO,
        connectTimeoutMs: 60_000,
      });
      console.log('[SOCKET CREATED]', new Date().toISOString(), `loja=${lojaId}`, 'user:', session.socket.user?.id);
      this.diag(session, '[Baileys] socket criado — aguardando eventos de conexão');

      session.socket.ev.on('creds.update', saveCreds);

      // Carrega mapeamentos LID desta loja
      const lidRows = await this.sql`SELECT lid, phone_jid FROM whatsapp_lid_map WHERE loja_id = ${lojaId}`;
      for (const r of lidRows) {
        session.lidToPhone.set(r.lid, r.phoneJid);
      }
      if (lidRows.length > 0 && session.socket?.signalRepository?.lidMapping) {
        await session.socket.signalRepository.lidMapping
          .storeLIDPNMappings(lidRows.map((r: any) => ({ lid: r.lid, pn: r.phoneJid })))
          .catch(() => {});
      }
      this.diag(session, `[Baileys] LID map carregado: ${lidRows.length} entradas`);

      const salvarLids = async (contacts: any[]) => {
        let novos = 0;
        for (const c of contacts) {
          if (c.lid && c.id) {
            await this.salvarMapeamentoLid(c.lid, c.id, session).catch(() => {});
            novos++;
          }
        }
        if (novos > 0 || contacts.length > 5) {
          const semLid = contacts.filter((c: any) => c.id && !c.lid).length;
          this.diag(session, `[Baileys] contacts sync: ${contacts.length} total, ${novos} com LID, ${semLid} sem LID`);
        }
      };
      session.socket.ev.on('contacts.upsert', salvarLids);
      session.socket.ev.on('contacts.update', salvarLids);

      session.socket.ev.on('connection.update', async (update: any) => {
        const { connection, lastDisconnect, qr } = update;
        this.diag(session, `[Baileys] connection.update: connection=${connection ?? 'n/a'} qr=${qr ? 'SIM' : 'não'}`);

        if (qr) {
          session.qrAtual = qr;
          session.status = 'aguardando';
          this.diag(session, '[Baileys] QR Code gerado — aguardando escaneamento');
        }

        if (connection === 'open') {
          session.status = 'conectado';
          session.qrAtual = null;
          session.reconectando = false;
          this.diag(session, '[Baileys] ✅ WhatsApp conectado');
          const waNumero = session.socket.user?.id
            ? jidNormalizedUser(session.socket.user.id).replace('@s.whatsapp.net', '')
            : null;
          this.sql`
            UPDATE lojas
            SET wa_status = 'conectado', wa_atualizado_em = NOW(),
                wa_numero = COALESCE(${waNumero}, wa_numero)
            WHERE id = ${lojaId}
          `.catch(() => {});
          this.tentarResolverPendentes(session).catch(() => {});
        }

        if (connection === 'close') {
          session.status = 'desconectado';
          session.qrAtual = null;
          this.sql`UPDATE lojas SET wa_status = 'desconectado', wa_atualizado_em = NOW() WHERE id = ${lojaId}`.catch(() => {});

          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const errorMsg = lastDisconnect?.error?.message ?? '';
          const deslogado = statusCode === DisconnectReason.loggedOut;

          this.diag(session, `[Baileys] conexão fechada — statusCode=${statusCode} deslogado=${deslogado} erro="${errorMsg}"`);

          if (deslogado) {
            session.reconectando = false;
            await this.sql`DELETE FROM baileys_auth_state WHERE id LIKE ${lojaId + ':%'}`.catch((e: any) =>
              this.diag(session, `[Baileys] erro ao limpar auth state: ${e?.message}`),
            );
            setTimeout(() => this.iniciarSessao(lojaId), 3_000);
          } else if (!session.reconectando) {
            session.reconectando = true;
            this.diag(session, '[Baileys] reconectando em 5s…');
            setTimeout(() => this.iniciarSessao(lojaId), 5_000);
          }
        }
      });

      session.socket.ev.on('messages.upsert', async ({ messages, type }: any) => {
        for (const m of (messages ?? [])) {
          console.log(`[RAW UPSERT loja=${lojaId.slice(0,8)}] type=${type} remoteJid=${m.key?.remoteJid} fromMe=${m.key?.fromMe} hasMessage=${!!m.message} messageStubType=${m.messageStubType ?? 'none'}`);
        }
        this.diag(session, `[Baileys] messages.upsert: type=${type} count=${messages?.length ?? 0}`);

        // Captura LID em ecos de envio
        for (const m of (messages ?? [])) {
          if (m.key?.fromMe && m.key?.remoteJid?.endsWith('@lid')) {
            const lid: string = m.key.remoteJid;
            const mid: string = m.key?.id ?? '';
            const phoneJid = mid ? session.pendingSendJids.get(mid) : undefined;
            if (phoneJid && !session.lidToPhone.has(lid)) {
              await this.salvarMapeamentoLid(lid, phoneJid, session);
              this.diag(session, `[Baileys] LID ${lid} → ${phoneJid} via eco (type=${type})`);
            }
          }
        }

        // Mensagens enviadas pelo celular chegam como type='append'
        if (type !== 'notify') {
          for (const m of (messages ?? [])) {
            const jid: string = m.key?.remoteJid ?? '';
            if (m.key?.fromMe && m.message && jid.endsWith('@s.whatsapp.net')) {
              this.diag(session, `[Baileys] eco celular (${type}) jid=${jid} — processando`);
              await this.processarMensagemEnviadaCelular(m, session).catch((err: any) =>
                this.diag(session, `[Baileys] erro ao processar eco celular: ${err?.message}`),
              );
            }
          }
          session.msgsIgnoradas++;
          return;
        }

        for (const msg of messages) {
          const jid = msg.key?.remoteJid ?? '';
          const fromMe = msg.key?.fromMe ?? false;
          const hasMsg = !!msg.message;
          this.diag(session, `[Baileys] msg: jid=${jid} fromMe=${fromMe} hasMsg=${hasMsg}`);

          if (fromMe) {
            if (jid.endsWith('@lid')) {
              const msgId: string = msg.key?.id ?? '';
              const phoneJid = msgId ? session.pendingSendJids.get(msgId) : undefined;
              if (phoneJid && !session.lidToPhone.has(jid)) {
                await this.salvarMapeamentoLid(jid, phoneJid, session);
                this.diag(session, `[Baileys] LID ${jid} → ${phoneJid} via eco de envio (msgId=${msgId})`);
              }
            }
            if (hasMsg) {
              await this.processarMensagemEnviadaCelular(msg, session).catch((err: any) =>
                this.diag(session, `[Baileys] erro ao processar msg celular: ${err?.message}`),
              );
            }
            session.msgsIgnoradas++;
            continue;
          }

          if (!hasMsg) {
            session.msgsIgnoradas++;
            continue;
          }

          if (jid.endsWith('@s.whatsapp.net')) {
            const agora = new Date().toISOString();
            session.ultimaMsgIndividualEm = agora;
            this.sql`UPDATE lojas SET wa_ultima_msg_individual_em = NOW() WHERE id = ${session.lojaId}`.catch(() => {});
          }

          await this.processarMensagemRecebida(msg, session).catch((err: any) =>
            this.diag(session, `[Baileys] erro ao processar mensagem: ${err?.message}`),
          );
        }
      });

    } catch (err: any) {
      this.diag(this.ensureSession(lojaId), `[Baileys] ERRO em iniciarSessao: ${err?.message ?? err}`);
      throw err;
    }
  }

  // ----------------------------------------------------------------
  // Motor de mensagens recebidas (por loja via closure da sessão)
  // ----------------------------------------------------------------

  private async processarMensagemRecebida(msg: any, session: LojaSession) {
    const lojaId = session.lojaId;
    let jid: string = msg.key.remoteJid ?? '';

    if (jid.endsWith('@lid')) {
      const resolvido = await this.resolverLid(jid, session);
      if (resolvido) {
        this.diag(session, `[Baileys] LID ${jid} resolvido → ${resolvido}`);
        jid = resolvido;
      } else {
        await this.salvarMensagemPendente(jid, msg, session);
        return;
      }
    }

    if (!jid.endsWith('@s.whatsapp.net')) {
      this.diag(session, `[Baileys] msg ignorada (grupo/status): jid=${jid}`);
      session.msgsIgnoradas++;
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
    const pushName: string | null = msg.pushName ?? null;

    if (!texto && TIPOS_PROTOCOLO.has(tipoMsg)) {
      this.diag(session, `[Baileys] msg protocolo ignorada (${tipoMsg}) de ${telefone}`);
      session.msgsIgnoradas++;
      return;
    }

    const contextInfo =
      msg.message?.extendedTextMessage?.contextInfo ??
      msg.message?.imageMessage?.contextInfo ??
      msg.message?.videoMessage?.contextInfo ??
      msg.message?.documentMessage?.contextInfo ??
      null;

    this.diag(session, `[Baileys] processando msg de ${telefone} tipo=${tipoMsg} texto="${texto.slice(0, 60)}"`);
    session.msgsRecebidas++;
    session.ultimaMsgEm = new Date().toISOString();

    // Busca cliente ativo nesta loja
    let [cliente] = await this.sql`
      SELECT id, loja_id, nome FROM clientes
      WHERE telefone = ${telefone} AND loja_id = ${lojaId} AND deleted_at IS NULL
      LIMIT 1
    `;

    let textoExibido = texto;

    if (!cliente) {
      const [deletado] = await this.sql`
        SELECT id, loja_id, nome FROM clientes
        WHERE telefone = ${telefone} AND loja_id = ${lojaId} AND deleted_at IS NOT NULL
        LIMIT 1
      `;
      if (deletado) {
        await this.sql`
          UPDATE clientes
          SET deleted_at = NULL, ativo = true, updated_at = NOW()
          WHERE id = ${deletado.id}
        `;
        cliente = { id: deletado.id, lojaId: deletado.lojaId, nome: deletado.nome };
        this.diag(session, `[Baileys] cliente ${telefone} reativado após soft-delete (id=${deletado.id})`);
      }
    }

    if (cliente) {
      this.diag(session, `[Baileys] cliente ${telefone} já existe (id=${cliente.id}) — captura de origem ignorada`);
    }

    // Auto-cria cliente novo — pertence à loja deste socket
    if (!cliente) {
      if (contextInfo) {
        this.logger.log(`[CTWA] contextInfo de ${telefone}: ${JSON.stringify(contextInfo, null, 2)}`);
      }

      const externalAdReply = contextInfo?.externalAdReply;
      let origemLead: string | null = null;
      let origemDetalhe: any = null;
      let ctwaClid: string | null = null;

      if (externalAdReply) {
        origemLead = 'meta_ads';
        ctwaClid = externalAdReply.ctwaClid ?? contextInfo?.ctwaClid ?? null;
        origemDetalhe = {
          sourceUrl:             externalAdReply.sourceUrl ?? null,
          title:                 externalAdReply.title ?? null,
          body:                  externalAdReply.body ?? null,
          sourceId:              externalAdReply.sourceId ?? null,
          sourceType:            externalAdReply.sourceType ?? null,
          mediaType:             externalAdReply.mediaType ?? null,
          renderLargerThumbnail: externalAdReply.renderLargerThumbnail ?? null,
          ctwaClid,
        };
        this.diag(session, `[Baileys] CTWA detectado para ${telefone}: sourceUrl=${origemDetalhe.sourceUrl} title="${origemDetalhe.title}" ctwaClid=${ctwaClid ?? 'ausente'}`);
      }

      // Tracking codes são buscados apenas desta loja (socket determina a loja)
      if (!origemLead && texto) {
        const codigos = await this.sql`
          SELECT codigo, rotulo FROM codigos_origem WHERE loja_id = ${lojaId}
        `;
        for (const { codigo, rotulo } of codigos) {
          const padraoComHash = `#${codigo}`.toLowerCase();
          if (texto.toLowerCase().includes(padraoComHash)) {
            origemLead = rotulo;
            origemDetalhe = { codigo };
            const regex = new RegExp(`#${codigo}`, 'gi');
            textoExibido = texto.replace(regex, '').trim();
            this.diag(session, `[Baileys] ORIGEM DETECTADA: código #${codigo} → "${rotulo}" para ${telefone}`);
            break;
          }
        }
        if (!origemLead) {
          this.diag(session, `[Baileys] NOVO CLIENTE ${telefone} — primeira mensagem sem código de origem: "${texto.slice(0, 80)}"`);
        }
      } else if (!origemLead && !texto) {
        this.diag(session, `[Baileys] NOVO CLIENTE ${telefone} — primeira mensagem sem texto (tipo=${Object.keys(contextInfo ?? {}).join(',')})`);
      }

      const nomeInicial = pushName || telefone;
      const [novoCliente] = await this.sql`
        INSERT INTO clientes
          (loja_id, nome, telefone, consentimento_whatsapp, origem_lead, origem_detalhe, whatsapp_nome)
        VALUES (
          ${lojaId},
          ${nomeInicial},
          ${telefone},
          false,
          ${origemLead},
          ${origemDetalhe ? JSON.stringify(origemDetalhe) : null},
          ${pushName ?? null}
        )
        ON CONFLICT (loja_id, telefone) DO NOTHING
        RETURNING id, loja_id, nome
      `;
      cliente = novoCliente;
      this.diag(session, `[Baileys] cliente auto-criado: ${telefone} nome="${nomeInicial}" (loja=${lojaId} origem=${origemLead ?? 'desconhecida'})`);

      // Dispara evento CTWA na Meta Conversions API (assíncrono, não bloqueia)
      if (origemLead === 'meta_ads') {
        this.metaAdsService.enviarEventoCTWA(lojaId, ctwaClid, telefone);
      }
    }

    if (cliente) {
      await this.registrarMensagem({
        telefone,
        lojaId: cliente.lojaId,
        direcao: 'recebida',
        conteudo: textoExibido || `[${tipoMsg}]`,
        whatsappMsgId,
      });
    }

    if (cliente) {
      // Detecção de adiamento tem prioridade sobre o fluxo estruturado
      if (texto) {
        const intencao = detectarIntencaoAdiamento(texto);
        if (intencao) {
          this.diag(session, `[ADIAMENTO] padrão detectado em "${texto.slice(0, 60)}" → ${intencao.dias} dias revisao=${intencao.precisaRevisao}`);
          const processado = await this.processarAdiamento(
            cliente.id, lojaId, telefone, intencao.dias, intencao.precisaRevisao, session,
          ).catch((e: any) => {
            this.diag(session, `[ADIAMENTO] erro: ${e?.message}`);
            return false;
          });
          if (processado) return;
        }
      }

      await this.processarComFluxo(cliente.id, cliente.lojaId, textoExibido || texto, telefone, session);
      if (texto) {
        await this.verificarGatilhoCompra(telefone, texto, cliente.lojaId).catch((e: any) =>
          this.diag(session, `[Baileys] erro em verificarGatilhoCompra (recebida): ${e?.message}`)
        );
      }
    } else if (/^[123]$/.test(texto.trim())) {
      await this.processarRespostaPorTelefone(texto.trim(), telefone, lojaId);
    }
  }

  // ----------------------------------------------------------------
  // Lembrete Personalizado: adiamento a pedido do cliente
  // ----------------------------------------------------------------

  private async processarAdiamento(
    clienteId: string,
    lojaId: string,
    telefone: string,
    dias: number,
    precisaRevisao: boolean,
    session: LojaSession,
  ): Promise<boolean> {
    // Tenta encontrar o ciclo via sessão ativa (lembrete enviado recentemente)
    let cicloId: string | null = null;

    const [sessaoAtiva] = await this.sql`
      SELECT lembrete_id FROM sessao_conversa
      WHERE loja_id = ${lojaId} AND cliente_id = ${clienteId} AND expira_em > NOW()
      ORDER BY created_at DESC LIMIT 1
    `;
    if (sessaoAtiva?.lembreteId) {
      const [lembreteCiclo] = await this.sql`
        SELECT ciclo_id FROM lembretes WHERE id = ${sessaoAtiva.lembreteId}
      `;
      cicloId = lembreteCiclo?.cicloId ?? null;
    }

    // Fallback: ciclo ativo mais próximo de disparar
    if (!cicloId) {
      const [cicloFallback] = await this.sql`
        SELECT id FROM ciclos_recompra
        WHERE cliente_id = ${clienteId} AND loja_id = ${lojaId}
          AND ativo = TRUE AND deleted_at IS NULL
        ORDER BY proxima_notificacao ASC NULLS LAST
        LIMIT 1
      `;
      cicloId = cicloFallback?.id ?? null;
    }

    if (!cicloId) {
      this.diag(session, `[ADIAMENTO] nenhum ciclo ativo para cliente=${clienteId} — ignorando`);
      return false;
    }

    const [ciclo] = await this.sql`
      SELECT proxima_notificacao, data_original_disparo FROM ciclos_recompra WHERE id = ${cicloId}
    `;

    // Preserva a data original na primeira vez que é adiado
    const dataOriginal = ciclo?.dataOriginalDisparo ?? ciclo?.proximaNotificacao ?? new Date();
    const novaData = new Date();
    novaData.setDate(novaData.getDate() + dias);

    await this.sql`
      UPDATE ciclos_recompra SET
        proxima_notificacao   = ${novaData},
        adiado_pelo_cliente   = TRUE,
        data_original_disparo = ${dataOriginal},
        prazo_solicitado_dias = ${dias},
        precisa_revisao       = ${precisaRevisao},
        updated_at            = NOW()
      WHERE id = ${cicloId}
    `;

    const dataFormatada = novaData.toLocaleDateString('pt-BR', {
      day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Sao_Paulo',
    });

    const confirmacao = `Certo! Vou te lembrar no dia ${dataFormatada}. Até lá!`;
    const msgId = await this.enviarMensagem(telefone, confirmacao, lojaId).catch(() => null);
    await this.registrarMensagem({
      telefone, lojaId, direcao: 'enviada', conteudo: confirmacao,
      whatsappMsgId: msgId || null, origem: 'sistema',
    });

    const [clienteRow] = await this.sql`SELECT nome FROM clientes WHERE id = ${clienteId}`;
    const clienteNome = clienteRow?.nome ?? telefone;

    const notifMsg = precisaRevisao
      ? `${clienteNome} pediu para ser lembrado em ${dataFormatada} (${dias} dias, período estimado — revise se necessário). Ajustado automaticamente.`
      : `${clienteNome} pediu para ser lembrado em ${dataFormatada} (${dias} dias). Ajustado automaticamente.`;

    await this.sql`
      INSERT INTO notificacoes_admin (loja_id, mensagem) VALUES (${lojaId}, ${notifMsg})
    `.catch(() => {});

    this.diag(session, `[ADIAMENTO] ciclo=${cicloId} → ${dataFormatada} (${dias}d) revisao=${precisaRevisao}`);
    return true;
  }

  // ----------------------------------------------------------------
  // Motor de fluxo configurável
  // ----------------------------------------------------------------

  private async processarComFluxo(
    clienteId: string,
    lojaId: string,
    texto: string,
    telefone: string,
    session: LojaSession,
  ) {
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

    this.diag(session, `[FLUXO] cliente=${clienteId} loja=${lojaId} sessao=${sessao?.id ?? 'NENHUMA'} lembreteId=${sessao?.lembreteId ?? 'null'} fluxo=${fluxo ? 'SIM' : 'NENHUM'} texto="${texto.slice(0, 40)}"`);

    if (!sessao || !fluxo) {
      this.diag(session, `[FLUXO] ${!sessao ? 'sem sessão ativa' : 'sem fluxo ativo'} → fallback legado para ${telefone}`);
      if (/^[123]$/.test(texto.trim())) {
        await this.processarRespostaPorTelefone(texto.trim(), telefone, lojaId);
      }
      return;
    }

    const gatilho = normalizarResposta(texto);

    const opcoesRaw = fluxo.opcoes ?? [];
    const opcoes = (typeof opcoesRaw === 'string' ? JSON.parse(opcoesRaw) : opcoesRaw) as OpcaoFluxo[];

    this.diag(session, `[FLUXO] gatilho="${gatilho}" opcoes=${opcoes.length} gatilhos=[${opcoes.map((o) => o.gatilho).join(',')}]`);

    const opcaoMatch = gatilho ? opcoes.find((o) => o.gatilho === gatilho) : null;

    if (!opcaoMatch) {
      const novosFallbacks = (sessao.fallbacks ?? 0) + 1;
      await this.sql`
        UPDATE sessao_conversa SET fallbacks = ${novosFallbacks}, updated_at = NOW() WHERE id = ${sessao.id}
      `;
      this.diag(session, `[FLUXO] sem match para gatilho="${gatilho}" — fallback ${novosFallbacks}/2 para ${telefone}`);
      if (novosFallbacks <= 2) {
        const fallbackMsg = fluxo.mensagemFallback ?? fluxo.mensagem_fallback;
        const fallbackMsgId = await this.enviarMensagem(telefone, fallbackMsg, lojaId);
        await this.registrarMensagem({ telefone, lojaId, direcao: 'enviada', conteudo: fallbackMsg, whatsappMsgId: fallbackMsgId || null, origem: 'sistema' });
        this.diag(session, `[FLUXO] mensagem fallback enviada para ${telefone}`);
      } else {
        this.diag(session, `[FLUXO] ${novosFallbacks} fallbacks para ${telefone} — parando respostas automáticas`);
      }
      return;
    }

    this.diag(session, `[FLUXO] MATCH gatilho="${gatilho}" acao="${opcaoMatch.acao}" para ${telefone}`);

    const respostaMsgId = await this.enviarMensagem(telefone, opcaoMatch.mensagem_resposta, lojaId);
    await this.registrarMensagem({ telefone, lojaId, direcao: 'enviada', conteudo: opcaoMatch.mensagem_resposta, whatsappMsgId: respostaMsgId || null, origem: 'sistema' });
    this.diag(session, `[FLUXO] mensagem resposta enviada para ${telefone}: "${opcaoMatch.mensagem_resposta.slice(0, 60)}"`);

    if (opcaoMatch.acao !== 'nenhuma' && sessao.lembreteId) {
      this.diag(session, `[FLUXO] executando acao="${opcaoMatch.acao}" lembreteId=${sessao.lembreteId}`);
      await this.executarAcaoFluxo(opcaoMatch.acao, sessao.lembreteId, opcaoMatch.acao_params).catch((e: any) =>
        this.diag(session, `[FLUXO] executarAcaoFluxo FALHOU: ${e?.message}`),
      );
      this.diag(session, `[FLUXO] acao="${opcaoMatch.acao}" concluída para lembreteId=${sessao.lembreteId}`);
    } else if (opcaoMatch.acao !== 'nenhuma' && !sessao.lembreteId) {
      this.diag(session, `[FLUXO] acao="${opcaoMatch.acao}" PULADA — sessão sem lembrete_id (modo teste?)`);
    }

    await this.sql`UPDATE sessao_conversa SET expira_em = NOW(), updated_at = NOW() WHERE id = ${sessao.id}`;
    this.diag(session, `[FLUXO] sessão ${sessao.id} encerrada após resposta "${gatilho}"`);
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
      case 'registrar_pedido': {
        const [etapaInicial] = await this.sql`
          SELECT id FROM etapas_jornada
          WHERE loja_id = ${lembrete.lojaId} AND tipo = 'intermediaria' AND ativo = true
          ORDER BY ordem
          LIMIT 1
        `;
        await this.sql`
          INSERT INTO pedidos (loja_id, lembrete_id, cliente_id, produto_id, quantidade, etapa_id, status)
          VALUES (${lembrete.lojaId}, ${lembrete.id}, ${lembrete.clienteId}, ${lembrete.produtoId}, ${parseFloat(lembrete.quantidade) || 1}, ${etapaInicial?.id ?? null}, 'pendente')
        `;
        await this.sql`UPDATE lembretes SET status='respondido', updated_at=NOW() WHERE id=${lembrete.id}`;
        break;
      }

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

  private async processarRespostaPorTelefone(opcao: string, telefone: string, lojaId: string) {
    const acaoMap: Record<string, string> = { '1': 'pedir', '2': 'depois', '3': 'sair' };
    const acao = acaoMap[opcao];
    if (!acao) return;

    const [cliente] = await this.sql`
      SELECT id, nome FROM clientes
      WHERE telefone = ${telefone} AND loja_id = ${lojaId} AND deleted_at IS NULL LIMIT 1
    `;
    if (!cliente) {
      this.logger.log(`[LEGADO] processarRespostaPorTelefone: cliente não encontrado para ${telefone} loja=${lojaId}`);
      return;
    }

    const [lembrete] = await this.sql`
      SELECT l.id FROM lembretes l
      JOIN ciclos_recompra cr ON cr.id = l.ciclo_id
      WHERE cr.cliente_id = ${cliente.id} AND l.status = 'enviado'
      ORDER BY l.enviado_em DESC LIMIT 1
    `;
    if (!lembrete) {
      this.logger.log(`[LEGADO] processarRespostaPorTelefone: nenhum lembrete 'enviado' para clienteId=${cliente.id} — ação ignorada`);
      return;
    }

    this.logger.log(`[LEGADO] processarRespostaPorTelefone: opcao="${opcao}" acao="${acao}" lembreteId=${lembrete.id} cliente=${cliente.id}`);
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
      case 'pedir': {
        const [etapaInicialLegado] = await this.sql`
          SELECT id FROM etapas_jornada
          WHERE loja_id = ${lembrete.lojaId} AND tipo = 'intermediaria' AND ativo = true
          ORDER BY ordem
          LIMIT 1
        `;
        await this.sql`
          INSERT INTO pedidos (loja_id, lembrete_id, cliente_id, produto_id, quantidade, etapa_id, status)
          VALUES (${lembrete.lojaId}, ${lembrete.id}, ${lembrete.clienteId}, ${lembrete.produtoId}, ${parseFloat(lembrete.quantidade) || 1}, ${etapaInicialLegado?.id ?? null}, 'pendente')
        `;
        await this.sql`UPDATE lembretes SET status='respondido', updated_at=NOW() WHERE id=${lembrete.id}`;
        break;
      }

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

  // Captura mensagens enviadas pelo lojista via celular
  private async processarMensagemEnviadaCelular(msg: any, session: LojaSession): Promise<void> {
    const lojaId = session.lojaId;
    const whatsappMsgId: string = msg.key?.id ?? '';
    if (!whatsappMsgId) return;

    let jid: string = msg.key.remoteJid ?? '';

    if (jid.endsWith('@lid')) {
      const resolvido = await this.resolverLid(jid, session).catch(() => null);
      if (!resolvido) {
        this.diag(session, `[Baileys] celular: LID ${jid} não resolvido — ignorando`);
        return;
      }
      jid = resolvido;
    }

    if (!jid.endsWith('@s.whatsapp.net')) return;

    const numero = jid.replace('@s.whatsapp.net', '');
    const telefone = '+' + numero;

    const texto =
      msg.message?.conversation ??
      msg.message?.extendedTextMessage?.text ??
      '';

    const tipoMsg = Object.keys(msg.message ?? {})[0] ?? 'desconhecido';

    if (!texto && TIPOS_PROTOCOLO.has(tipoMsg)) return;

    // Busca cliente desta loja
    const [clienteCelular] = await this.sql`
      SELECT id, loja_id FROM clientes
      WHERE telefone = ${telefone} AND loja_id = ${lojaId} AND deleted_at IS NULL LIMIT 1
    `;

    if (!clienteCelular) {
      this.diag(session, `[Baileys] celular: cliente não encontrado para ${telefone} loja=${lojaId} — msg não salva`);
      return;
    }

    const salvo = await this.registrarMensagem({
      telefone,
      lojaId: clienteCelular.lojaId,
      direcao: 'enviada',
      conteudo: texto || `[${tipoMsg}]`,
      whatsappMsgId,
      origem: 'celular',
    });

    if (salvo > 0) {
      this.diag(session, `[Baileys] msg celular salva → ${telefone}: "${texto.slice(0, 60)}"`);
      if (texto) {
        await this.verificarGatilhoCompra(telefone, texto, clienteCelular.lojaId).catch((e: any) =>
          this.diag(session, `[Baileys] erro em verificarGatilhoCompra: ${e?.message}`),
        );
      }
    }
  }

  normalizarTexto(s: string): string {
    return normalizarTexto(s);
  }

  private extrairValorMonetario(texto: string): number | null {
    const padroes = [
      /R\$\s*(\d{1,3}(?:\.\d{3})*,\d{1,2})/i,
      /R\$\s*(\d+,\d{1,2})/i,
      /R\$\s*(\d+\.\d{1,2})/i,
      /R\$\s*(\d+)/i,
      /(\d{1,3}(?:\.\d{3})+,\d{1,2})/,
      /(\d+,\d{2})/,
    ];
    for (const p of padroes) {
      const m = p.exec(texto);
      if (m) {
        let raw = m[1];
        if (raw.includes(',')) raw = raw.replace(/\./g, '').replace(',', '.');
        const v = parseFloat(raw);
        if (!isNaN(v) && v > 0) return v;
      }
    }
    return null;
  }

  async verificarGatilhoCompra(telefone: string, texto: string, lojaId: string): Promise<void> {
    const textoNorm = this.normalizarTexto(texto);

    const gatilhos = await this.sql`
      SELECT frase FROM gatilhos_compra WHERE loja_id = ${lojaId} AND ativo = true
    `;
    this.logger.log(`[GATILHO] testando ${gatilhos.length} gatilho(s) para ${telefone} | msg="${texto.slice(0, 60)}"`);
    if (!gatilhos.length) {
      this.logger.log(`[GATILHO] nenhum gatilho ativo para loja=${lojaId} — abortando`);
      return;
    }

    for (const g of gatilhos) {
      const fraseNorm = this.normalizarTexto(g.frase);
      this.logger.log(`[GATILHO] frase="${g.frase}" norm="${fraseNorm}" | textoNorm="${textoNorm.slice(0, 60)}" | match=${textoNorm.includes(fraseNorm)}`);
    }

    const match = gatilhos.find((g: any) => textoNorm.includes(this.normalizarTexto(g.frase)));
    if (!match) {
      this.logger.log(`[GATILHO] nenhum match para msg de ${telefone}`);
      return;
    }

    this.logger.log(`[GATILHO] MATCH frase="${match.frase}" para ${telefone}`);

    const [cliente] = await this.sql`
      SELECT id FROM clientes WHERE telefone = ${telefone} AND loja_id = ${lojaId} AND deleted_at IS NULL LIMIT 1
    `;
    if (!cliente) {
      this.logger.log(`[GATILHO] cliente não encontrado para ${telefone} loja=${lojaId} — abortando`);
      return;
    }
    this.logger.log(`[GATILHO] cliente encontrado id=${cliente.id}`);

    const [pedidoAberto] = await this.sql`
      SELECT p.id FROM pedidos p
      JOIN etapas_jornada ej ON ej.id = p.etapa_id
      WHERE p.cliente_id = ${cliente.id}
        AND p.loja_id = ${lojaId}
        AND p.deleted_at IS NULL
        AND ej.tipo = 'intermediaria'
      ORDER BY p.created_at DESC
      LIMIT 1
    `;

    const [etapaComprou] = await this.sql`
      SELECT id FROM etapas_jornada WHERE loja_id = ${lojaId} AND tipo = 'final_comprou' LIMIT 1
    `;

    const valor = this.extrairValorMonetario(texto);
    this.logger.log(`[GATILHO] valor extraído da mensagem: ${valor ?? 'nenhum'}`);

    if (pedidoAberto) {
      await this.sql`
        UPDATE pedidos SET
          etapa_id       = ${etapaComprou?.id ?? null},
          status_jornada = 'comprou',
          confirmado_por = 'palavra_chave',
          confirmado_em  = NOW(),
          valor          = COALESCE(${valor}, valor),
          updated_at     = NOW()
        WHERE id = ${pedidoAberto.id}
      `;
      this.logger.log(`[GATILHO] pedido ${pedidoAberto.id} → comprou via palavra_chave, valor=${valor ?? 'não capturado'}`);
    } else {
      await this.sql`
        INSERT INTO pedidos (loja_id, cliente_id, etapa_id, status_jornada, confirmado_por, confirmado_em, valor)
        VALUES (${lojaId}, ${cliente.id}, ${etapaComprou?.id ?? null}, 'comprou', 'palavra_chave', NOW(), ${valor})
      `;
      this.logger.log(`[GATILHO] nenhum pedido aberto para cliente=${cliente.id} — pedido direto criado via palavra_chave, valor=${valor ?? 'não capturado'}`);
    }
  }

  private async registrarMensagem(params: {
    telefone: string;
    lojaId: string;
    direcao: 'recebida' | 'enviada';
    conteudo: string;
    whatsappMsgId?: string | null;
    lembreteId?: string | null;
    origem?: string | null;
  }): Promise<number> {
    try {
      const result = await this.sql`
        INSERT INTO mensagens_whatsapp
          (loja_id, lembrete_id, cliente_id, direcao, conteudo, whatsapp_message_id, tipo, origem)
        SELECT
          c.loja_id,
          ${params.lembreteId ?? null},
          c.id,
          ${params.direcao}::mensagem_direcao,
          ${params.conteudo},
          ${params.whatsappMsgId ?? null},
          ${params.lembreteId ? 'lembrete' : 'manual'},
          ${params.origem ?? null}
        FROM clientes c
        WHERE c.telefone = ${params.telefone}
          AND c.loja_id = ${params.lojaId}
          AND c.deleted_at IS NULL
        LIMIT 1
        ON CONFLICT (loja_id, whatsapp_message_id)
          WHERE whatsapp_message_id IS NOT NULL
          DO NOTHING
      `;
      return result.count ?? 0;
    } catch (err: any) {
      this.logger.log(`[Baileys] erro ao registrar mensagem: ${err?.message}`);
      return -1;
    }
  }

  // ----------------------------------------------------------------
  // Envio de mensagens (usa o socket da loja correta)
  // ----------------------------------------------------------------

  async enviarLembrete(params: {
    telefone: string;
    clienteNome: string;
    clienteWhatsappNome?: string | null;
    produtoNome: string;
    quantidade?: string;
    unidade?: string;
    lembreteId: string;
    lojaId: string;
  }) {
    const { telefone, clienteNome, clienteWhatsappNome, produtoNome, quantidade, lembreteId, lojaId } = params;

    const nomeEhTelefone = /^\+\d{8,15}$/.test(clienteNome.trim());
    const nomeEfetivo = (nomeEhTelefone && clienteWhatsappNome) ? clienteWhatsappNome : clienteNome;

    const [fluxo] = await this.sql`
      SELECT mensagem_lembrete FROM fluxo_conversa WHERE loja_id = ${lojaId} AND ativo = true LIMIT 1
    `;

    const templateBase: string =
      fluxo?.mensagemLembrete ?? fluxo?.mensagem_lembrete ?? MENSAGEM_LEMBRETE_PADRAO;

    const qtdTexto = quantidade ? ` (${quantidade})` : '';

    const [loja] = await this.sql`SELECT nome FROM lojas WHERE id = ${lojaId}`;
    const texto = interpolarVariaveis(templateBase, {
      nome: nomeEfetivo,
      produto: produtoNome,
      quantidade: qtdTexto,
      loja: loja?.nome ?? '',
    });

    const msgId = await this.enviarMensagem(telefone, texto, lojaId);
    await this.registrarMensagem({
      telefone, lojaId, direcao: 'enviada', conteudo: texto, lembreteId,
      whatsappMsgId: msgId || null, origem: 'sistema',
    });

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
      this.logger.log(`[SESSAO] criada: clienteId=${cliente.id} lembreteId=${lembreteId} loja=${lojaId} expira_em=+48h`);
    } else {
      this.logger.warn(`[SESSAO] AVISO: cliente não encontrado para ${telefone} loja=${lojaId} — sessão NÃO criada`);
    }
  }

  async enviarMensagem(telefone: string, texto: string, lojaId: string): Promise<string> {
    const session = this.sessions.get(lojaId);

    if (!session || !session.socket || session.status !== 'conectado') {
      throw new Error(`WhatsApp da loja ${lojaId} não está conectado. Escaneie o QR Code em /configuracoes.`);
    }

    const numero = telefone.replace('+', '').replace(/\D/g, '');
    const jid = `${numero}@s.whatsapp.net`;

    const enviado = await session.socket.sendMessage(jid, { text: texto });

    const sentJid: string = enviado?.key?.remoteJid ?? '';
    if (sentJid.endsWith('@lid')) {
      await this.salvarMapeamentoLid(sentJid, jid, session);
      this.diag(session, `[Baileys] LID capturado ao enviar: ${sentJid} → ${jid}`);
    }

    const msgId: string = enviado?.key?.id ?? '';
    if (msgId) {
      session.pendingSendJids.set(msgId, jid);
      setTimeout(() => session.pendingSendJids.delete(msgId), 60_000);
    }

    this.logger.log(`Mensagem enviada para ${telefone} via loja ${lojaId}`);
    return msgId;
  }

  // ----------------------------------------------------------------
  // API pública para o controller (todos os métodos são por loja)
  // ----------------------------------------------------------------

  estaConectado(lojaId: string): boolean {
    return this.sessions.get(lojaId)?.status === 'conectado';
  }

  getQrCode(lojaId: string): { qrcode: string | null; status: StatusConexao } {
    const session = this.sessions.get(lojaId);

    // Se não há socket ativo, inicia a sessão em background (ex: loja pausada que o usuário quer reconectar)
    if (!session?.socket) {
      if (!this.iniciando.has(lojaId)) {
        this.iniciando.add(lojaId);
        this.iniciarSessao(lojaId)
          .catch((err) => this.logger.error(`[Baileys] erro ao iniciar sessão on-demand ${lojaId}: ${err?.message}`))
          .finally(() => this.iniciando.delete(lojaId));
      }
      return { qrcode: null, status: 'aguardando' };
    }

    return { qrcode: session.qrAtual, status: session.status };
  }

  getDiagnostico(lojaId: string) {
    const session = this.sessions.get(lojaId);
    return {
      lojaId,
      status: session?.status ?? 'desconectado',
      qrcodePresente: !!(session?.qrAtual),
      socketAtivo: !!(session?.socket),
      reconectando: session?.reconectando ?? false,
      msgsRecebidas: session?.msgsRecebidas ?? 0,
      msgsIgnoradas: session?.msgsIgnoradas ?? 0,
      ultimaMsgEm: session?.ultimaMsgEm ?? null,
      ultimaMsgIndividualEm: session?.ultimaMsgIndividualEm ?? null,
      wsReadyState: session?.socket?.ws?.readyState ?? null,
      logs: session ? [...session.diagLogs] : [],
    };
  }

  async marcarLidaNoWhatsApp(telefone: string, messageIds: string[], lojaId: string): Promise<void> {
    const session = this.sessions.get(lojaId);
    if (!session?.socket || session.status !== 'conectado' || messageIds.length === 0) return;
    const numero = telefone.replace('+', '').replace(/\D/g, '');
    const jid = `${numero}@s.whatsapp.net`;
    const keys = messageIds.map((id) => ({ remoteJid: jid, id, fromMe: false }));
    await session.socket.readMessages(keys).catch((e: any) =>
      this.diag(session, `[Baileys] readMessages falhou: ${e?.message}`),
    );
  }

  async desconectar(lojaId: string) {
    const session = this.sessions.get(lojaId);
    if (!session) return;
    session.reconectando = false;
    await session.socket?.logout();
    session.socket = null;
    session.qrAtual = null;
    session.status = 'desconectado';
  }

  async reconectar(lojaId: string) {
    this.logger.log(`[Baileys] reconectar() chamado para loja ${lojaId}`);
    const session = this.ensureSession(lojaId);
    session.reconectando = true;
    session.socket?.end(undefined);
    session.socket = null;
    session.qrAtual = null;
    session.status = 'desconectado';
    // Apaga apenas o auth state desta loja (prefixado com lojaId)
    await this.sql`DELETE FROM baileys_auth_state WHERE id LIKE ${lojaId + ':%'}`.catch(() => {});
    session.reconectando = false;
    await this.iniciarSessao(lojaId);
  }
}
