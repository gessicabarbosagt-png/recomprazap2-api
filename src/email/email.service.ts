import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

export interface ResumoSaudeDados {
  falhaSilenciosa:   Array<{ id: string; nome: string }>;
  desconectadas:     Array<{ id: string; nome: string; waStatus: string }>;
  inadimplentes:     Array<{ id: string; nome: string; statusAssinatura: string }>;
  lembretesRepresados: number;
  vendasSemValor:    number;
  totalAtivas:       number;
  lembretesEnviados: number;
  vendasConfirmadas: number;
  receitaConfirmada: number;
  novosLeads:        number;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  // Chave = 'tipo:lojaId', valor = timestamp ms do último envio
  private readonly alertasEnviados = new Map<string, number>();
  private readonly COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 horas

  constructor(private readonly config: ConfigService) {}

  private get from(): string {
    return this.config.get<string>('RESEND_FROM') ?? 'noreply@recomprazap.com.br';
  }

  private get adminEmail(): string {
    return this.config.get<string>('ADMIN_EMAIL') ?? 'gessicabarbosa.gt@gmail.com';
  }

  // Retorna false se um alerta do mesmo tipo/loja foi enviado nas últimas 4h
  private podEnviarAlerta(tipo: string, lojaId: string): boolean {
    const key = `${tipo}:${lojaId}`;
    const ultimo = this.alertasEnviados.get(key);
    if (ultimo && Date.now() - ultimo < this.COOLDOWN_MS) return false;
    this.alertasEnviados.set(key, Date.now());
    return true;
  }

  private async enviar(to: string | string[], subject: string, html: string): Promise<void> {
    const apiKey = this.config.get<string>('RESEND_API_KEY');
    if (!apiKey) {
      this.logger.warn('[Email] RESEND_API_KEY não configurada — email não enviado');
      return;
    }
    try {
      const resend = new Resend(apiKey);
      const dest = Array.isArray(to) ? to : [to];
      const { error } = await resend.emails.send({ from: this.from, to: dest, subject, html });
      if (error) throw new Error(JSON.stringify(error));
      this.logger.log(`[Email] enviado: to=${dest.join(',')} assunto="${subject}"`);
    } catch (e: any) {
      this.logger.warn(`[Email] falha ao enviar "${subject}": ${e?.message}`);
    }
  }

  // ── Alertas imediatos ────────────────────────────────────────────────────────

  async enviarAlertaFalhaSilenciosa(lojaId: string, lojaNome: string): Promise<void> {
    if (!this.podEnviarAlerta('falha_silenciosa', lojaId)) return;
    const subject = `⚠️ RecompraZap: possível falha silenciosa em ${lojaNome}`;
    await this.enviar(this.adminEmail, subject, this.htmlAlerta({
      titulo: '⚠️ Possível falha silenciosa no inbox',
      cor: '#d97706',
      corpo: `
        <p>A loja <strong>${this.esc(lojaNome)}</strong> está com <code>wa_status = 'conectado'</code>
        no banco mas não recebeu mensagens individuais há mais de 6 horas.</p>
        <p>Isso pode indicar um <em>phantom connection</em>: o socket aparenta estar ativo
        mas não processa mensagens de clientes.</p>
        <p><strong>Ação sugerida:</strong> acesse Configurações da loja e reconecte via QR Code.</p>
      `,
    }));
  }

  async enviarAlertaDesconexao(lojaId: string, lojaNome: string): Promise<void> {
    if (!this.podEnviarAlerta('desconexao', lojaId)) return;
    const subject = `⚠️ RecompraZap: loja desconectada — ${lojaNome}`;
    await this.enviar(this.adminEmail, subject, this.htmlAlerta({
      titulo: '⚠️ Loja desconectada do WhatsApp',
      cor: '#dc2626',
      corpo: `
        <p>A loja <strong>${this.esc(lojaNome)}</strong> acabou de perder a conexão com o WhatsApp.</p>
        <p>Enquanto desconectada, lembretes <em>não serão enviados</em> e
        mensagens de clientes <em>não serão recebidas</em>.</p>
        <p>O sistema tentará se reconectar automaticamente.
        Se o problema persistir, acesse Configurações e reconecte via QR Code.</p>
      `,
    }));
  }

  async enviarAlertaPagamentoRecusado(lojaId: string, lojaNome: string, emailLoja: string): Promise<void> {
    if (!this.podEnviarAlerta('pagamento_recusado', lojaId)) return;
    const subject = `⚠️ RecompraZap: pagamento recusado — ${lojaNome}`;
    await this.enviar(this.adminEmail, subject, this.htmlAlerta({
      titulo: '⚠️ Pagamento recusado pelo Mercado Pago',
      cor: '#dc2626',
      corpo: `
        <p>O pagamento da loja <strong>${this.esc(lojaNome)}</strong>
        (e-mail: ${this.esc(emailLoja)}) foi recusado.</p>
        <p>A loja foi marcada como <strong>inadimplente</strong>.
        Se não regularizar em 5 dias, será suspensa automaticamente.</p>
      `,
    }));
  }

  // ── Resumo diário ────────────────────────────────────────────────────────────

  async enviarResumoDiario(dados: ResumoSaudeDados, periodo: string): Promise<void> {
    const temAtencao =
      dados.falhaSilenciosa.length > 0 ||
      dados.desconectadas.length > 0 ||
      dados.inadimplentes.length > 0 ||
      dados.lembretesRepresados > 0 ||
      dados.vendasSemValor > 0;

    const subject = temAtencao
      ? `⚠️ RecompraZap ${periodo} — atenção necessária`
      : `✅ RecompraZap ${periodo} — tudo certo`;

    await this.enviar(this.adminEmail, subject, this.htmlResumoDiario(dados, periodo, temAtencao));
  }

  // ── Templates HTML ────────────────────────────────────────────────────────────

  private esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private htmlAlerta({ titulo, cor, corpo }: { titulo: string; cor: string; corpo: string }): string {
    const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1f2937;background:#ffffff">
<div style="border-left:4px solid ${cor};padding:16px 20px;background:#fafafa;margin-bottom:20px">
  <h2 style="margin:0 0 12px;color:${cor};font-size:18px">${titulo}</h2>
  ${corpo}
</div>
<hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0">
<p style="color:#9ca3af;font-size:12px;margin:0">RecompraZap Admin · ${agora} BRT</p>
</body></html>`;
  }

  private htmlResumoDiario(d: ResumoSaudeDados, periodo: string, temAtencao: boolean): string {
    const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const receita = Number(d.receitaConfirmada).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

    const secaoAtencao = temAtencao
      ? `<div style="border-left:4px solid #d97706;padding:16px 20px;background:#fffbeb;margin-bottom:24px">
  <h2 style="margin:0 0 12px;color:#b45309;font-size:16px">⚠️ Atenção necessária</h2>
  ${d.falhaSilenciosa.length > 0 ? `
  <p style="margin:8px 0 4px;font-weight:600">Falha silenciosa detectada (${d.falhaSilenciosa.length})</p>
  <ul style="margin:0 0 12px;padding-left:20px">${d.falhaSilenciosa.map(l => `<li>${this.esc(l.nome)}</li>`).join('')}</ul>` : ''}
  ${d.desconectadas.length > 0 ? `
  <p style="margin:8px 0 4px;font-weight:600">Lojas desconectadas (${d.desconectadas.length})</p>
  <ul style="margin:0 0 12px;padding-left:20px">${d.desconectadas.map(l => `<li>${this.esc(l.nome)} <span style="color:#6b7280">(${this.esc(l.waStatus)})</span></li>`).join('')}</ul>` : ''}
  ${d.inadimplentes.length > 0 ? `
  <p style="margin:8px 0 4px;font-weight:600">Inadimplentes / suspensas (${d.inadimplentes.length})</p>
  <ul style="margin:0 0 12px;padding-left:20px">${d.inadimplentes.map(l => `<li>${this.esc(l.nome)} <span style="color:#6b7280">(${this.esc(l.statusAssinatura)})</span></li>`).join('')}</ul>` : ''}
  ${d.lembretesRepresados > 0 ? `<p style="margin:8px 0"><strong>Lembretes com falha:</strong> ${d.lembretesRepresados} aguardando revisão</p>` : ''}
  ${d.vendasSemValor > 0 ? `<p style="margin:8px 0"><strong>Vendas sem valor informado:</strong> ${d.vendasSemValor}</p>` : ''}
</div>`
      : `<div style="border-left:4px solid #059669;padding:12px 20px;background:#ecfdf5;margin-bottom:24px">
  <p style="margin:0;color:#065f46;font-weight:600">✅ Tudo certo — nenhum problema detectado</p>
</div>`;

    const tr = (label: string, value: string, zebra: boolean) =>
      `<tr style="${zebra ? 'background:#f9fafb' : ''}">
        <td style="padding:8px 12px;border:1px solid #e5e7eb">${label}</td>
        <td style="padding:8px 12px;border:1px solid #e5e7eb;font-weight:600">${value}</td>
       </tr>`;

    return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1f2937;background:#ffffff">
<h1 style="font-size:20px;margin:0 0 4px">RecompraZap — Resumo de Saúde</h1>
<p style="color:#6b7280;font-size:14px;margin:0 0 24px">${periodo} · ${agora} BRT</p>

${secaoAtencao}

<h2 style="font-size:16px;margin:0 0 12px">Resumo geral (últimas 12h)</h2>
<table style="width:100%;border-collapse:collapse;font-size:14px">
  ${tr('Lojas ativas no sistema', String(d.totalAtivas), false)}
  ${tr('Lembretes enviados', String(d.lembretesEnviados), true)}
  ${tr('Vendas confirmadas', String(d.vendasConfirmadas), false)}
  ${tr('Receita confirmada', receita, true)}
  ${tr('Novos leads', String(d.novosLeads), false)}
</table>

<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">
<p style="color:#9ca3af;font-size:12px;margin:0">RecompraZap Admin · Relatório automático</p>
</body></html>`;
  }
}
