import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DATABASE_CLIENT } from '../database/database.module';
import { WhatsappBaileysService } from '../whatsapp/whatsapp-baileys.service';
import { UpsertFluxoDto, TestarFluxoDto } from './dto/upsert-fluxo.dto';
import {
  MENSAGEM_LEMBRETE_PADRAO,
  MENSAGEM_FALLBACK_PADRAO,
  OPCOES_PADRAO,
  interpolarVariaveis,
} from './fluxo-conversa.types';

@Injectable()
export class FluxoConversaService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly sql: any,
    private readonly baileysService: WhatsappBaileysService,
  ) {}

  async buscar(lojaId: string) {
    const padrao = {
      mensagem_lembrete: MENSAGEM_LEMBRETE_PADRAO,
      mensagem_fallback: MENSAGEM_FALLBACK_PADRAO,
      opcoes: OPCOES_PADRAO,
      ativo: true,
    };

    try {
      const [fluxo] = await this.sql`
        SELECT id, loja_id, mensagem_lembrete, mensagem_fallback, opcoes, ativo, updated_at
        FROM fluxo_conversa
        WHERE loja_id = ${lojaId}
      `;

      if (!fluxo) return padrao;

      // Coluna opcoes pode ser TEXT em produção (em vez de JSONB) — parse defensivo
      const opcoes = typeof fluxo.opcoes === 'string'
        ? JSON.parse(fluxo.opcoes)
        : (fluxo.opcoes ?? padrao.opcoes);

      return { ...fluxo, opcoes };
    } catch {
      return padrao;
    }
  }

  async upsert(lojaId: string, dto: UpsertFluxoDto) {
    const gatilhos = dto.opcoes.map((o) => o.gatilho);
    const gatilhosUnicos = new Set(gatilhos);
    if (gatilhosUnicos.size !== gatilhos.length) {
      throw new BadRequestException('Gatilhos duplicados — cada opção deve ter um gatilho único');
    }

    const opcoesJson = JSON.stringify(dto.opcoes);

    const [fluxo] = await this.sql`
      INSERT INTO fluxo_conversa (loja_id, mensagem_lembrete, mensagem_fallback, opcoes, ativo)
      VALUES (${lojaId}, ${dto.mensagem_lembrete}, ${dto.mensagem_fallback}, ${opcoesJson}::jsonb, true)
      ON CONFLICT (loja_id) DO UPDATE SET
        mensagem_lembrete = EXCLUDED.mensagem_lembrete,
        mensagem_fallback = EXCLUDED.mensagem_fallback,
        opcoes            = EXCLUDED.opcoes,
        ativo             = true,
        updated_at        = NOW()
      RETURNING id, loja_id, mensagem_lembrete, mensagem_fallback, opcoes, ativo, updated_at
    `;

    return fluxo;
  }

  async testar(lojaId: string, dto: TestarFluxoDto) {
    const { telefone } = dto;

    const fluxo = await this.buscar(lojaId);
    const [loja] = await this.sql`SELECT nome FROM lojas WHERE id = ${lojaId}`;

    const texto = interpolarVariaveis(fluxo.mensagem_lembrete ?? fluxo.mensagemLembrete, {
      nome: 'Você',
      produto: 'Produto Teste',
      quantidade: ' (1 un)',
      loja: loja?.nome ?? '',
    });

    if (!this.baileysService.estaConectado()) {
      throw new BadRequestException('WhatsApp não está conectado. Escaneie o QR Code em Configurações.');
    }

    await this.baileysService.enviarMensagem(telefone, texto, lojaId);

    // Cria sessão de teste se o cliente existir na base desta loja
    const [cliente] = await this.sql`
      SELECT id FROM clientes WHERE telefone = ${telefone} AND loja_id = ${lojaId} AND deleted_at IS NULL LIMIT 1
    `;

    if (cliente) {
      // Busca o lembrete mais recente do cliente para vincular à sessão de teste
      // (sem isso, ações como registrar_pedido seriam puladas por falta de lembrete_id)
      const [ultimoLembrete] = await this.sql`
        SELECT l.id FROM lembretes l
        JOIN ciclos_recompra cr ON cr.id = l.ciclo_id
        WHERE cr.cliente_id = ${cliente.id}
        ORDER BY l.created_at DESC
        LIMIT 1
      `;

      await this.sql`DELETE FROM sessao_conversa WHERE loja_id = ${lojaId} AND cliente_id = ${cliente.id} AND expira_em > NOW()`;
      await this.sql`
        INSERT INTO sessao_conversa (loja_id, cliente_id, lembrete_id, expira_em)
        VALUES (${lojaId}, ${cliente.id}, ${ultimoLembrete?.id ?? null}, NOW() + INTERVAL '48 hours')
      `;
      return { ok: true, sessaoCriada: true, lembreteVinculado: ultimoLembrete?.id ?? null };
    }

    return { ok: true, sessaoCriada: false, aviso: 'Mensagem enviada, mas não foi possível criar sessão de teste — este telefone não está cadastrado como cliente desta loja.' };
  }
}
