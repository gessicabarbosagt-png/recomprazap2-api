import { Injectable, Inject, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { DATABASE_CLIENT } from '../database/database.module';
import { encriptar, decriptar } from '../common/cripto';

export type StatusMetaAds = 'conectado' | 'erro_config' | 'desativado';

@Injectable()
export class MetaAdsService {
  private readonly logger = new Logger(MetaAdsService.name);

  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
  ) {}

  async buscarConfig(lojaId: string) {
    const [loja] = await this.sql`
      SELECT meta_pixel_id, meta_access_token, meta_integration_ativa, meta_eventos_ativos
      FROM lojas WHERE id = ${lojaId}
    `;
    return {
      pixelId: loja?.metaPixelId ?? null,
      temToken: !!loja?.metaAccessToken,
      ativa: loja?.metaIntegrationAtiva ?? false,
      eventosAtivos: loja?.metaEventosAtivos ?? ['lead_ctwa'],
      status: this.calcularStatus(loja),
    };
  }

  async salvarConfig(lojaId: string, dto: {
    pixelId?: string | null;
    accessToken?: string;
    ativa?: boolean;
    eventosAtivos?: string[];
  }) {
    const tokenCifrado = dto.accessToken ? encriptar(dto.accessToken) : null;
    const eventosJson = dto.eventosAtivos ? JSON.stringify(dto.eventosAtivos) : null;

    await this.sql`
      UPDATE lojas SET
        meta_pixel_id          = CASE WHEN ${dto.pixelId !== undefined} THEN ${dto.pixelId ?? null}
                                      ELSE meta_pixel_id END,
        meta_access_token      = CASE WHEN ${tokenCifrado !== null} THEN ${tokenCifrado}
                                      ELSE meta_access_token END,
        meta_integration_ativa = CASE WHEN ${dto.ativa !== undefined} THEN ${dto.ativa ?? false}
                                      ELSE meta_integration_ativa END,
        meta_eventos_ativos    = CASE WHEN ${eventosJson !== null} THEN ${eventosJson}::jsonb
                                      ELSE meta_eventos_ativos END,
        updated_at = NOW()
      WHERE id = ${lojaId}
    `;
    return this.buscarConfig(lojaId);
  }

  async limparToken(lojaId: string) {
    await this.sql`
      UPDATE lojas SET meta_access_token = NULL, updated_at = NOW() WHERE id = ${lojaId}
    `;
    return { ok: true };
  }

  private calcularStatus(loja: any): StatusMetaAds {
    if (!loja?.metaIntegrationAtiva) return 'desativado';
    if (!loja?.metaPixelId || !loja?.metaAccessToken) return 'erro_config';
    return 'conectado';
  }

  private sha256Phone(telefone: string): string {
    const normalizado = telefone.replace(/\D/g, '');
    return crypto.createHash('sha256').update(normalizado).digest('hex');
  }

  private async buscarConfigLoja(lojaId: string) {
    const [loja] = await this.sql`
      SELECT meta_pixel_id, meta_access_token, meta_integration_ativa, meta_eventos_ativos
      FROM lojas WHERE id = ${lojaId}
    `;
    return loja;
  }

  private async dispararEvento(lojaId: string, evento: string, payload: object) {
    const loja = await this.buscarConfigLoja(lojaId);
    if (!loja?.metaIntegrationAtiva || !loja?.metaPixelId || !loja?.metaAccessToken) return;

    const eventos: string[] = loja.metaEventosAtivos ?? [];
    if (!eventos.includes(evento)) return;

    let token: string;
    try {
      token = decriptar(loja.metaAccessToken);
    } catch {
      this.logger.warn(`[MetaAds] token inválido para loja ${lojaId}`);
      return;
    }

    try {
      const body = { data: [payload], access_token: token };
      const res = await fetch(
        `https://graph.facebook.com/v18.0/${loja.metaPixelId}/events`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const err = await res.text().catch(() => '');
        this.logger.warn(`[MetaAds] evento "${evento}" falhou (loja=${lojaId}): ${err}`);
      } else {
        this.logger.log(`[MetaAds] evento "${evento}" enviado (loja=${lojaId})`);
      }
    } catch (err: any) {
      this.logger.warn(`[MetaAds] erro ao enviar evento "${evento}" (loja=${lojaId}): ${err?.message}`);
    }
  }

  // Dispara evento Lead quando chega mensagem CTWA — chamada assíncrona, não bloqueia
  enviarEventoCTWA(lojaId: string, ctwaClid: string | null, telefone: string | null) {
    const userData: Record<string, any> = {};
    if (ctwaClid) userData['ctwa_clid'] = ctwaClid;
    if (telefone) userData['ph'] = [this.sha256Phone(telefone)];

    this.dispararEvento(lojaId, 'lead_ctwa', {
      event_name: 'Lead',
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      user_data: userData,
    }).catch(() => {});
  }

  // Dispara evento Purchase quando pedido vira "Comprou" — chamada assíncrona, não bloqueia
  enviarEventoCompra(lojaId: string, telefone: string | null, valor: number | null) {
    const userData: Record<string, any> = {};
    if (telefone) userData['ph'] = [this.sha256Phone(telefone)];

    this.dispararEvento(lojaId, 'purchase_comprou', {
      event_name: 'Purchase',
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'business_messaging',
      messaging_channel: 'whatsapp',
      user_data: userData,
      custom_data: { currency: 'BRL', value: valor ?? 0 },
    }).catch(() => {});
  }
}
