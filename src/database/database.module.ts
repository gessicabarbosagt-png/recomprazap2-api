import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import postgres = require('postgres');

export const DATABASE_CLIENT = 'DATABASE_CLIENT';

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_CLIENT,
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => {
        const connectionString = config.get<string>('DATABASE_URL');
        const sql = postgres(connectionString, { max: 10, transform: postgres.camel });

        // Migrations de startup — idempotentes, seguras para rodar sempre
        await sql`ALTER TABLE mensagens_whatsapp ADD COLUMN IF NOT EXISTS tipo VARCHAR(20)`.catch(() => {});
        await sql`
          CREATE TABLE IF NOT EXISTS baileys_auth_state (
            id          TEXT PRIMARY KEY,
            value       TEXT NOT NULL,
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `.catch(() => {});
        await sql`ALTER TABLE ciclos_recompra ADD COLUMN IF NOT EXISTS status_ultimo_envio VARCHAR(20)`.catch(() => {});
        await sql`ALTER TABLE lojas ADD COLUMN IF NOT EXISTS modelo_mensagem TEXT`.catch(() => {});
        await sql`
          CREATE TABLE IF NOT EXISTS whatsapp_lid_map (
            lid        TEXT PRIMARY KEY,
            phone_jid  TEXT NOT NULL,
            loja_id    UUID,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `.catch(() => {});
        await sql`ALTER TABLE whatsapp_lid_map ADD COLUMN IF NOT EXISTS loja_id UUID`.catch(() => {});
        await sql`
          CREATE TABLE IF NOT EXISTS whatsapp_mensagens_pendentes_lid (
            id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            lid          TEXT NOT NULL,
            msg_raw      JSONB NOT NULL,
            recebido_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            tentativas   INT NOT NULL DEFAULT 0,
            resolvido_em TIMESTAMPTZ,
            loja_id      UUID
          )
        `.catch(() => {});
        await sql`
          CREATE INDEX IF NOT EXISTS idx_pendentes_lid_unresolved
          ON whatsapp_mensagens_pendentes_lid (lid)
          WHERE resolvido_em IS NULL
        `.catch(() => {});

        // ---- Fluxo de conversa configurável por loja ----
        await sql`
          CREATE TABLE IF NOT EXISTS fluxo_conversa (
            id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            loja_id           UUID NOT NULL UNIQUE,
            mensagem_lembrete TEXT NOT NULL,
            mensagem_fallback TEXT NOT NULL,
            opcoes            JSONB NOT NULL DEFAULT '[]',
            ativo             BOOLEAN NOT NULL DEFAULT true,
            created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `.catch(() => {});

        // Garante que opcoes é JSONB (pode ter sido criada como TEXT em versões antigas)
        await sql`
          ALTER TABLE fluxo_conversa ALTER COLUMN opcoes TYPE JSONB USING opcoes::jsonb
        `.catch(() => {});

        await sql`
          CREATE TABLE IF NOT EXISTS sessao_conversa (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            loja_id     UUID NOT NULL,
            cliente_id  UUID NOT NULL,
            contexto    TEXT NOT NULL DEFAULT 'aguardando_resposta_lembrete',
            lembrete_id UUID,
            fallbacks   INT NOT NULL DEFAULT 0,
            expira_em   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '48 hours',
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `.catch(() => {});

        await sql`
          CREATE INDEX IF NOT EXISTS idx_sessao_ativa
          ON sessao_conversa (loja_id, cliente_id)
          WHERE expira_em > NOW()
        `.catch(() => {});

        // Seed: para cada loja sem fluxo, cria o fluxo padrão preservando modelo_mensagem customizado
        const mensagemLembretePadrao =
          `Oi, {nome}! 👋\n\nJá está na hora de repor *{produto}*{quantidade}. Posso te ajudar?\n\nResponda:\n1️⃣ *1* — Quero pedir\n2️⃣ *2* — Me avise depois\n3️⃣ *3* — Não quero mais`;
        const mensagemFallbackPadrao =
          `Não entendi sua resposta. Por favor, responda com *1*, *2* ou *3* conforme as opções enviadas anteriormente.`;
        const opcoesPadrao = JSON.stringify([
          { gatilho: '1', rotulo: 'Quero pedir', mensagem_resposta: 'Ótimo! Seu pedido foi registrado. Em breve entraremos em contato. 😊', acao: 'registrar_pedido' },
          { gatilho: '2', rotulo: 'Me avise depois', mensagem_resposta: 'Tudo bem! Vou te avisar de novo em 7 dias. 📅', acao: 'adiar_lembrete', acao_params: { dias: 7 } },
          { gatilho: '3', rotulo: 'Não quero mais', mensagem_resposta: 'Entendido! Pausei os lembretes desse produto. Se precisar de algo, estamos aqui. 😊', acao: 'cancelar_ciclo' },
        ]);
        await sql`
          INSERT INTO fluxo_conversa (loja_id, mensagem_lembrete, mensagem_fallback, opcoes)
          SELECT
            l.id,
            COALESCE(l.modelo_mensagem, ${mensagemLembretePadrao}),
            ${mensagemFallbackPadrao},
            ${opcoesPadrao}::jsonb
          FROM lojas l
          WHERE NOT EXISTS (SELECT 1 FROM fluxo_conversa fc WHERE fc.loja_id = l.id)
        `.catch(() => {});

        // Para lojas que já tinham fluxo_conversa com o padrão mas modelo_mensagem customizado:
        // copia o modelo_mensagem → mensagem_lembrete, sem sobrescrever fluxos já editados.
        await sql`
          UPDATE fluxo_conversa fc
          SET mensagem_lembrete = l.modelo_mensagem, updated_at = NOW()
          FROM lojas l
          WHERE fc.loja_id = l.id
            AND l.modelo_mensagem IS NOT NULL
            AND l.modelo_mensagem != ${mensagemLembretePadrao}
            AND fc.mensagem_lembrete = ${mensagemLembretePadrao}
        `.catch(() => {});

        // Seed: códigos de origem padrão para cada loja que ainda não tem nenhum
        await sql`
          INSERT INTO codigos_origem (loja_id, codigo, rotulo)
          SELECT l.id, v.codigo, v.rotulo
          FROM lojas l
          CROSS JOIN (VALUES
            ('instagram', 'Instagram'),
            ('insta',     'Instagram'),
            ('google',    'Google'),
            ('face',      'Facebook'),
            ('site',      'Site'),
            ('indicacao', 'Indicação')
          ) AS v(codigo, rotulo)
          WHERE NOT EXISTS (
            SELECT 1 FROM codigos_origem co WHERE co.loja_id = l.id AND co.codigo = v.codigo
          )
        `.catch(() => {});

        // ---- Jornada de compra ----
        await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS status_jornada TEXT NOT NULL DEFAULT 'aguardando'`.catch(() => {});
        await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS valor NUMERIC(10,2)`.catch(() => {});
        await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS confirmado_em TIMESTAMPTZ`.catch(() => {});
        await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS confirmado_por TEXT`.catch(() => {});
        // Pedidos criados via gatilho direto (sem lembrete) não têm produto/quantidade conhecidos
        await sql`ALTER TABLE pedidos ALTER COLUMN produto_id DROP NOT NULL`.catch(() => {});
        await sql`ALTER TABLE pedidos ALTER COLUMN quantidade DROP NOT NULL`.catch(() => {});

        await sql`
          CREATE TABLE IF NOT EXISTS gatilhos_compra (
            id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            loja_id    UUID NOT NULL,
            frase      TEXT NOT NULL,
            ativo      BOOLEAN NOT NULL DEFAULT false,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `.catch(() => {});

        // Seed: frase de exemplo (desativada) por loja sem nenhum gatilho
        await sql`
          INSERT INTO gatilhos_compra (loja_id, frase, ativo)
          SELECT id, 'Obrigado pela compra', false
          FROM lojas l
          WHERE NOT EXISTS (SELECT 1 FROM gatilhos_compra g WHERE g.loja_id = l.id)
        `.catch(() => {});

        // ---- Etapas da jornada de compra ----
        await sql`
          CREATE TABLE IF NOT EXISTS etapas_jornada (
            id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            loja_id    UUID NOT NULL,
            nome       TEXT NOT NULL,
            ordem      INT NOT NULL DEFAULT 0,
            tipo       TEXT NOT NULL CHECK (tipo IN ('intermediaria','final_comprou','final_nao_comprou')),
            ativo      BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `.catch(() => {});
        await sql`CREATE INDEX IF NOT EXISTS idx_etapas_jornada_loja ON etapas_jornada (loja_id, ordem)`.catch(() => {});
        await sql`
          INSERT INTO etapas_jornada (loja_id, nome, ordem, tipo)
          SELECT l.id, v.nome, v.ordem, v.tipo
          FROM lojas l
          CROSS JOIN (VALUES
            ('Aguardando retorno', 1, 'intermediaria'),
            ('Orçamento enviado',  2, 'intermediaria'),
            ('Comprou',            3, 'final_comprou'),
            ('Não comprou',        4, 'final_nao_comprou')
          ) AS v(nome, ordem, tipo)
          WHERE NOT EXISTS (SELECT 1 FROM etapas_jornada ej WHERE ej.loja_id = l.id)
        `.catch(() => {});
        await sql`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS etapa_id UUID REFERENCES etapas_jornada(id)`.catch(() => {});
        await sql`
          UPDATE pedidos p
          SET etapa_id = (
            SELECT ej.id FROM etapas_jornada ej
            WHERE ej.loja_id = p.loja_id
              AND (
                (p.status_jornada = 'aguardando'        AND ej.tipo = 'intermediaria' AND ej.ordem = 1) OR
                (p.status_jornada = 'orcamento_enviado' AND ej.tipo = 'intermediaria' AND ej.ordem = 2) OR
                (p.status_jornada = 'comprou'           AND ej.tipo = 'final_comprou') OR
                (p.status_jornada = 'nao_comprou'       AND ej.tipo = 'final_nao_comprou')
              )
            LIMIT 1
          )
          WHERE p.etapa_id IS NULL AND p.deleted_at IS NULL
        `.catch(() => {});

        return sql;
      },
    },
  ],
  exports: [DATABASE_CLIENT],
})
export class DatabaseModule {}
