import {
  Injectable, Inject, Logger,
  BadRequestException,
} from '@nestjs/common';
import { DATABASE_CLIENT } from '../database/database.module';
import { WhatsappService } from '../whatsapp/whatsapp.service';

const MENSAGEM_TESTE =
  'Oi! Este é um teste do RecompraZap 👋 Apenas uma demonstração de como seus clientes vão receber os avisos de recompra. Lembrando que você personaliza a mensagem do jeito que quiser.\n\n' +
  'Já está na hora de repor *Ração Golden para Gatos 1kg*! Posso te ajudar?\n\n' +
  'Responda:\n' +
  '1️⃣ *1* — Quero pedir\n' +
  '2️⃣ *2* — Me avise depois\n' +
  '3️⃣ *3* — Não quero mais';

function normalizarTelefone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (!digits) throw new BadRequestException('Número de telefone inválido');

  let tel = digits;
  if (!tel.startsWith('55')) tel = '55' + tel;

  // Aceita 12 dígitos (55 + DDD + 8d) ou 13 (55 + DDD + 9 + 8d)
  if (tel.length < 12 || tel.length > 13) {
    throw new BadRequestException(
      'Número inválido. Use o formato: (DDD) + número — ex: 11 98765-4321',
    );
  }

  return tel;
}

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
    private readonly whatsapp: WhatsappService,
  ) {}

  async enviarTeste(lojaId: string, telefoneRaw: string): Promise<{ ok: boolean }> {
    if (!this.whatsapp.estaConectado(lojaId)) {
      throw new BadRequestException(
        'WhatsApp não está conectado. Conecte seu WhatsApp nas Configurações antes de enviar o teste.',
      );
    }

    const telefone = normalizarTelefone(telefoneRaw);

    await this.whatsapp.enviarMensagem(lojaId, telefone, MENSAGEM_TESTE);
    this.logger.log(`Teste de onboarding enviado para ${telefone} (loja ${lojaId})`);

    await this.sql`
      UPDATE lojas SET onboarding_teste_enviado = TRUE, updated_at = NOW()
      WHERE id = ${lojaId}
    `;

    return { ok: true };
  }

  async checklist(lojaId: string) {
    const [row] = await this.sql`
      SELECT
        l.onboarding_teste_enviado,
        l.wa_status,
        (SELECT COUNT(*) FROM produtos p WHERE p.loja_id = l.id AND p.deleted_at IS NULL)::int AS total_produtos,
        (SELECT COUNT(*) FROM clientes c WHERE c.loja_id = l.id AND c.deleted_at IS NULL)::int AS total_clientes,
        (l.mp_subscription_id IS NOT NULL) AS pagamento_configurado
      FROM lojas l
      WHERE l.id = ${lojaId} AND l.deleted_at IS NULL
    `;

    const waConectado          = row?.waStatus === 'conectado';
    const testEnviado          = Boolean(row?.onboardingTesteEnviado);
    const produtosSuficientes  = Number(row?.totalProdutos) >= 2;
    const clientesSuficientes  = Number(row?.totalClientes) > 1;
    const pagamentoConfigurado = Boolean(row?.pagamentoConfigurado);

    return {
      waConectado,
      testEnviado,
      produtosSuficientes,
      clientesSuficientes,
      pagamentoConfigurado,
      completo: waConectado && testEnviado && produtosSuficientes && clientesSuficientes && pagamentoConfigurado,
    };
  }
}
