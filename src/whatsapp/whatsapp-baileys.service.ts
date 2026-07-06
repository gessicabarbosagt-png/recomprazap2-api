import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
} from '@nestjs/common';
import { DATABASE_CLIENT } from '../database/database.module';
import { useDatabaseAuthState } from './baileys-auth-state';

// Importações do Baileys via require para compatibilidade CommonJS
const {
  makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
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
  // Mapa LID → JID telefone: necessário porque WhatsApp envia @lid em vez de @s.whatsapp.net
  private readonly lidToPhone = new Map<string, string>();
  // Rastreia msgId → phoneJid para descobrir LID a partir do echo fromMe=true
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

  // ----------------------------------------------------------------
  // Conexão Baileys
  // ----------------------------------------------------------------

  private async iniciarSessao() {
    // Reseta a flag para que reconexões futuras sejam agendadas corretamente
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
      this.diag('[Baileys] socket criado — aguardando eventos de conexão');

      this.socket.ev.on('creds.update', saveCreds);

      // Carrega mapeamentos LID→telefone persistidos para sobreviver a redeployments
      const lidRows = await this.sql`SELECT lid, phone_jid FROM whatsapp_lid_map`;
      for (const r of lidRows) {
        this.lidToPhone.set(r.lid, r.phoneJid);
      }
      this.diag(`[Baileys] LID map carregado do banco: ${lidRows.length} entradas`);

      // Persiste LID→telefone em contacts.upsert e contacts.update
      const salvarLids = async (contacts: any[]) => {
        let novos = 0;
        for (const c of contacts) {
          if (c.lid && c.id) {
            this.lidToPhone.set(c.lid, c.id);
            novos++;
            this.sql`
              INSERT INTO whatsapp_lid_map (lid, phone_jid, updated_at)
              VALUES (${c.lid}, ${c.id}, NOW())
              ON CONFLICT (lid) DO UPDATE SET phone_jid = EXCLUDED.phone_jid, updated_at = NOW()
            `.catch(() => {});
          }
        }
        if (novos > 0) this.diag(`[Baileys] contacts: ${novos} LID(s) persistidos (mapa total: ${this.lidToPhone.size})`);
      };
      this.socket.ev.on('contacts.upsert', salvarLids);
      this.socket.ev.on('contacts.update', salvarLids);

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
        }

        if (connection === 'close') {
          this.status = 'desconectado';
          this.qrAtual = null;

          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const errorMsg = lastDisconnect?.error?.message ?? '';
          const deslogado = statusCode === DisconnectReason.loggedOut;

          this.diag(`[Baileys] conexão fechada — statusCode=${statusCode} deslogado=${deslogado} erro="${errorMsg}"`);

          if (deslogado) {
            this.diag('[Baileys] loggedOut — limpando creds do banco e reiniciando para gerar novo QR Code');
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

      this.socket.ev.on('messages.upsert', async ({ messages, type }: any) => {
        for (const m of (messages ?? [])) {
          this.diag(`[RAW UPSERT] type=${type} remoteJid=${m.key?.remoteJid} fromMe=${m.key?.fromMe} hasMessage=${!!m.message} messageStubType=${m.messageStubType ?? 'none'}`);
        }
        this.diag(`[Baileys] messages.upsert: type=${type} count=${messages?.length ?? 0}`);

        // Captura LID de echos fromMe=true ANTES de descartar type=append
        for (const m of (messages ?? [])) {
          if (m.key?.fromMe && m.key?.remoteJid?.endsWith('@lid')) {
            const lid: string = m.key.remoteJid;
            const mid: string = m.key?.id ?? '';
            const phoneJid = mid ? this.pendingSendJids.get(mid) : undefined;
            if (phoneJid && !this.lidToPhone.has(lid)) {
              this.lidToPhone.set(lid, phoneJid);
              this.sql`
                INSERT INTO whatsapp_lid_map (lid, phone_jid, updated_at)
                VALUES (${lid}, ${phoneJid}, NOW())
                ON CONFLICT (lid) DO UPDATE SET phone_jid = EXCLUDED.phone_jid, updated_at = NOW()
              `.catch(() => {});
              this.diag(`[Baileys] LID ${lid} → ${phoneJid} via echo (type=${type})`);
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
            // Aproveita o echo de mensagens enviadas para descobrir LID→phone
            if (jid.endsWith('@lid')) {
              const msgId: string = msg.key?.id ?? '';
              const phoneJid = msgId ? this.pendingSendJids.get(msgId) : undefined;
              if (phoneJid && !this.lidToPhone.has(jid)) {
                this.lidToPhone.set(jid, phoneJid);
                this.sql`
                  INSERT INTO whatsapp_lid_map (lid, phone_jid, updated_at)
                  VALUES (${jid}, ${phoneJid}, NOW())
                  ON CONFLICT (lid) DO UPDATE SET phone_jid = EXCLUDED.phone_jid, updated_at = NOW()
                `.catch(() => {});
                this.diag(`[Baileys] LID ${jid} → ${phoneJid} descoberto via echo de envio (msgId=${msgId})`);
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
  // Mensagens recebidas
  // ----------------------------------------------------------------

  private async processarMensagemRecebida(msg: any) {
    let jid: string = msg.key.remoteJid ?? '';

    // WhatsApp envia @lid em vez de @s.whatsapp.net para alguns contatos — resolve via mapa
    if (jid.endsWith('@lid')) {
      let resolvido = this.lidToPhone.get(jid);
      if (!resolvido) {
        // Fallback: tenta no banco (o mapa em memória reseta a cada redeploy)
        const [row] = await this.sql`SELECT phone_jid FROM whatsapp_lid_map WHERE lid = ${jid}`;
        resolvido = row?.phoneJid;
        if (resolvido) this.lidToPhone.set(jid, resolvido); // cache
      }
      if (resolvido) {
        this.diag(`[Baileys] LID ${jid} resolvido para ${resolvido}`);
        jid = resolvido;
      } else {
        this.diag(`[Baileys] LID ${jid} sem mapeamento (contato nunca sincronizado) — ignorando`);
        this.msgsIgnoradas++;
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

    // Persiste no histórico
    const rows = await this.registrarMensagem({
      telefone,
      direcao: 'recebida',
      conteudo: texto || `[${tipoMsg}]`,
      whatsappMsgId,
    });

    if (rows === 0) {
      this.diag(`[Baileys] AVISO: nenhum cliente cadastrado com telefone ${telefone} — mensagem não salva`);
    } else {
      this.diag(`[Baileys] mensagem salva: ${rows} linha(s) para ${telefone}`);
    }

    // Interpreta respostas numéricas: 1 = pedir, 2 = depois, 3 = não quero mais
    if (/^[123]$/.test(texto.trim())) {
      await this.processarRespostaPorTelefone(texto.trim(), telefone);
    }
  }

  private async processarRespostaPorTelefone(opcao: string, telefone: string) {
    const acaoMap: Record<string, string> = { '1': 'pedir', '2': 'depois', '3': 'sair' };
    const acao = acaoMap[opcao];
    if (!acao) return;

    this.diag(`[Baileys] processarRespostaPorTelefone: opcao="${opcao}" telefone="${telefone}"`);

    // Verifica se o cliente existe no banco com esse telefone
    const [cliente] = await this.sql`
      SELECT id, nome FROM clientes WHERE telefone = ${telefone} AND deleted_at IS NULL LIMIT 1
    `;
    if (!cliente) {
      this.diag(`[Baileys] AVISO: cliente não encontrado para telefone "${telefone}" — verifique o formato (+55XXXXXXXXXXX)`);
      return;
    }
    this.diag(`[Baileys] cliente encontrado: ${cliente.nome} (id=${cliente.id})`);

    const [lembrete] = await this.sql`
      SELECT l.id, l.status, l.enviado_em
      FROM lembretes l
      JOIN ciclos_recompra cr ON cr.id = l.ciclo_id
      WHERE cr.cliente_id = ${cliente.id}
        AND l.status = 'enviado'
      ORDER BY l.enviado_em DESC
      LIMIT 1
    `;

    if (!lembrete) {
      // Diagnóstico extra: mostra os últimos lembretes desse cliente independente do status
      const recentes = await this.sql`
        SELECT l.id, l.status, l.enviado_em
        FROM lembretes l
        JOIN ciclos_recompra cr ON cr.id = l.ciclo_id
        WHERE cr.cliente_id = ${cliente.id}
        ORDER BY l.enviado_em DESC NULLS LAST
        LIMIT 3
      `;
      this.diag(`[Baileys] nenhum lembrete com status=enviado para ${cliente.nome}. Últimos: ${JSON.stringify(recentes.map((r: any) => ({ id: r.id, status: r.status, em: r.enviadoEm })))}`);
      return;
    }

    this.diag(`[Baileys] resposta "${opcao}" → ação "${acao}" para lembrete ${lembrete.id} (enviado_em=${lembrete.enviadoEm})`);
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

    if (!lembrete) {
      this.logger.warn(`Lembrete ${lembreteId} não encontrado`);
      return;
    }

    switch (acao) {
      case 'pedir':
        await this.sql`
          INSERT INTO pedidos (loja_id, lembrete_id, cliente_id, produto_id, quantidade, status)
          VALUES (
            ${lembrete.lojaId}, ${lembrete.id},
            ${lembrete.clienteId}, ${lembrete.produtoId},
            ${lembrete.quantidade ?? 1}, 'pendente'
          )
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
          VALUES (
            ${lembrete.lojaId}, ${lembrete.clienteId},
            ${codigo}, 10.00, CURRENT_DATE + INTERVAL '30 days'
          )
        `;
        await this.sql`UPDATE ciclos_recompra SET ativo=FALSE, updated_at=NOW() WHERE id=${lembrete.cicloId}`;
        await this.sql`UPDATE lembretes SET status='respondido', updated_at=NOW() WHERE id=${lembrete.id}`;
        this.logger.log(`Cupom de retenção ${codigo} gerado`);
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

  private static readonly TEMPLATE_PADRAO =
    `Oi, {nome}! 👋\n\nJá está na hora de repor *{produto}*{quantidade}. Posso te ajudar?\n\nResponda:\n1️⃣ *1* — Quero pedir\n2️⃣ *2* — Me avise depois\n3️⃣ *3* — Não quero mais`;

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

    const [loja] = await this.sql`SELECT nome, modelo_mensagem FROM lojas WHERE id = ${lojaId}`;

    const template: string = loja?.modeloMensagem || WhatsappBaileysService.TEMPLATE_PADRAO;

    const qtdTexto = quantidade
      ? ` (${quantidade}${unidade ? ' ' + unidade : ''})`
      : '';

    const texto = template
      .replace(/\{nome\}/g, clienteNome)
      .replace(/\{produto\}/g, produtoNome)
      .replace(/\{quantidade\}/g, qtdTexto)
      .replace(/\{loja\}/g, loja?.nome ?? '');

    await this.enviarMensagem(telefone, texto);

    await this.registrarMensagem({
      telefone,
      direcao: 'enviada',
      conteudo: texto,
      lembreteId,
    });
  }

  async enviarMensagem(telefone: string, texto: string) {
    if (!this.socket || this.status !== 'conectado') {
      throw new Error('WhatsApp não está conectado. Escaneie o QR Code em /configuracoes.');
    }

    const numero = telefone.replace('+', '').replace(/\D/g, '');
    const jid = `${numero}@s.whatsapp.net`;

    // Resolve LID antes de enviar — garante que a resposta do cliente seja processada
    const lidJaConhecido = [...this.lidToPhone.values()].some(v => v === jid);
    if (!lidJaConhecido) {
      try {
        const results = await this.socket.onWhatsApp(numero);
        const info = Array.isArray(results) ? results[0] : results;
        const lid: string | undefined = info?.lid;
        if (lid && info?.exists !== false) {
          this.lidToPhone.set(lid, jid);
          this.sql`
            INSERT INTO whatsapp_lid_map (lid, phone_jid, updated_at)
            VALUES (${lid}, ${jid}, NOW())
            ON CONFLICT (lid) DO UPDATE SET phone_jid = EXCLUDED.phone_jid, updated_at = NOW()
          `.catch(() => {});
          this.diag(`[Baileys] LID via onWhatsApp: ${lid} → ${jid}`);
        } else {
          this.diag(`[Baileys] onWhatsApp(${numero}): sem LID no retorno (exists=${info?.exists})`);
        }
      } catch (e: any) {
        this.diag(`[Baileys] onWhatsApp(${numero}) falhou: ${e?.message}`);
      }
    }

    const enviado = await this.socket.sendMessage(jid, { text: texto });

    // Também registra msgId→phone como fallback para capturar LID via echo
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
