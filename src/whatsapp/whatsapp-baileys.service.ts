import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  Inject,
} from '@nestjs/common';
import { join } from 'path';
import { DATABASE_CLIENT } from '../database/database.module';

// Importações do Baileys via require para compatibilidade CommonJS
const {
  makeWASocket,
  useMultiFileAuthState,
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

  private diag(msg: string) {
    const entry = `${new Date().toISOString()} ${msg}`;
    this.diagLogs.push(entry);
    if (this.diagLogs.length > 50) this.diagLogs.shift();
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
    try {
      const authPath = join(process.cwd(), 'baileys_auth');
      this.diag(`[Baileys] authPath: ${authPath}`);

      const { state, saveCreds } = await useMultiFileAuthState(authPath);
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
            this.diag('[Baileys] loggedOut — reiniciando para gerar novo QR Code');
            this.reconectando = false;
            setTimeout(() => this.iniciarSessao(), 3_000);
          } else if (!this.reconectando) {
            this.reconectando = true;
            this.diag('[Baileys] reconectando em 5s…');
            setTimeout(() => this.iniciarSessao(), 5_000);
          }
        }
      });

      this.socket.ev.on('messages.upsert', async ({ messages, type }: any) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
          if (msg.key.fromMe || !msg.message) continue;
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
    const jid: string = msg.key.remoteJid ?? '';
    if (!jid.endsWith('@s.whatsapp.net')) return; // ignora grupos

    const numero = jid.replace('@s.whatsapp.net', '');
    const telefone = '+' + numero;

    const texto =
      msg.message?.conversation ??
      msg.message?.extendedTextMessage?.text ??
      msg.message?.buttonsResponseMessage?.selectedButtonId ??
      msg.message?.templateButtonReplyMessage?.selectedId ??
      '';

    const whatsappMsgId: string = msg.key.id ?? '';

    this.logger.log(`Mensagem recebida de ${telefone}: ${texto}`);

    // Persiste no histórico
    await this.registrarMensagem({
      telefone,
      direcao: 'entrada',
      conteudo: texto,
      whatsappMsgId,
    });

    // Interpreta respostas de botão: formato "acao:lembreteId"
    if (texto.includes(':')) {
      const [acao, lembreteId] = texto.split(':');
      await this.processarResposta(acao, lembreteId, telefone);
    }
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
    direcao: 'entrada' | 'saida';
    conteudo: string;
    whatsappMsgId?: string;
    lembreteId?: string | null;
  }) {
    try {
      await this.sql`
        INSERT INTO mensagens_whatsapp
          (loja_id, lembrete_id, cliente_id, direcao, conteudo, whatsapp_msg_id, tipo)
        SELECT
          cr.loja_id,
          ${params.lembreteId ?? null},
          c.id,
          ${params.direcao},
          ${params.conteudo},
          ${params.whatsappMsgId ?? null},
          ${params.direcao === 'saida' ? 'lembrete' : 'manual'}
        FROM clientes c
        JOIN ciclos_recompra cr ON cr.cliente_id = c.id
        WHERE c.telefone = ${params.telefone}
          AND cr.deleted_at IS NULL
        LIMIT 1
        ON CONFLICT DO NOTHING
      `;
    } catch (err) {
      this.logger.warn('Não foi possível registrar mensagem no histórico', err?.message);
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
  }) {
    const { telefone, clienteNome, produtoNome, quantidade, unidade, lembreteId } = params;

    const qtdTexto = quantidade
      ? ` (${quantidade}${unidade ? ' ' + unidade : ''})`
      : '';

    const texto = `Oi, ${clienteNome}! 👋\n\nJá está na hora de repor *${produtoNome}*${qtdTexto}. Posso te ajudar a pedir?\n\nResponda com:\n✅ *pedir:${lembreteId}*\n⏰ *depois:${lembreteId}*\n❌ *sair:${lembreteId}*`;

    await this.enviarMensagem(telefone, texto);

    await this.registrarMensagem({
      telefone,
      direcao: 'saida',
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

    await this.socket.sendMessage(jid, { text: texto });
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
    await this.iniciarSessao();
  }
}
