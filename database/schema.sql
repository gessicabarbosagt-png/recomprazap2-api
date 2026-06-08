-- =============================================================
-- RecompraZap — Schema PostgreSQL
-- Versão: 1.0
-- =============================================================
-- INSTRUÇÕES DE USO:
-- Execute este arquivo no banco de dados PostgreSQL do projeto.
-- Exemplo: psql -U postgres -d recomprazap -f recomprazap_schema.sql
-- =============================================================


-- -------------------------------------------------------------
-- EXTENSÕES
-- -------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";  -- Gera UUIDs automaticamente


-- =============================================================
-- MÓDULO 1: LOJAS (tenants)
-- Cada loja é um tenant isolado. Tudo no sistema depende desta tabela.
-- =============================================================

CREATE TABLE lojas (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    nome            VARCHAR(255) NOT NULL,
    email           VARCHAR(255) NOT NULL UNIQUE,
    telefone        VARCHAR(20),
    slug            VARCHAR(100) NOT NULL UNIQUE,   -- Ex: "petshop-do-joao" (usado em URLs)
    ativa           BOOLEAN NOT NULL DEFAULT TRUE,
    plano           VARCHAR(50) NOT NULL DEFAULT 'gratuito', -- 'gratuito', 'basico', 'pro'
    -- Configurações operacionais da loja
    horario_abertura    TIME,                        -- Ex: 08:00
    horario_fechamento  TIME,                        -- Ex: 18:00
    dias_funcionamento  INTEGER[] DEFAULT '{1,2,3,4,5}', -- 0=dom, 1=seg... 6=sab
    -- Controle de retry de lembretes (configurável pelo lojista)
    retry_automatico    BOOLEAN NOT NULL DEFAULT TRUE,
    horas_para_retry    INTEGER NOT NULL DEFAULT 24,
    -- Timestamps
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ                      -- Soft delete
);

COMMENT ON TABLE lojas IS 'Cada registro é um tenant (loja) do sistema.';
COMMENT ON COLUMN lojas.slug IS 'Identificador amigável único da loja, usado em URLs.';
COMMENT ON COLUMN lojas.dias_funcionamento IS 'Array de dias da semana. 0=Domingo, 6=Sábado.';


-- =============================================================
-- MÓDULO 2: USUÁRIOS DA LOJA
-- Os funcionários/donos que acessam o painel web.
-- =============================================================

CREATE TABLE usuarios (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    loja_id         UUID NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
    nome            VARCHAR(255) NOT NULL,
    email           VARCHAR(255) NOT NULL UNIQUE,
    senha_hash      VARCHAR(255) NOT NULL,           -- Nunca armazenar senha em texto puro
    perfil          VARCHAR(50) NOT NULL DEFAULT 'operador', -- 'dono', 'operador'
    ativo           BOOLEAN NOT NULL DEFAULT TRUE,
    -- Timestamps
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

COMMENT ON TABLE usuarios IS 'Usuários do painel web (lojistas e operadores).';
COMMENT ON COLUMN usuarios.perfil IS 'dono: acesso total. operador: acesso limitado.';


-- =============================================================
-- MÓDULO 3: CLIENTES DA LOJA
-- Os consumidores finais que recebem os lembretes no WhatsApp.
-- =============================================================

CREATE TABLE clientes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    loja_id         UUID NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
    nome            VARCHAR(255) NOT NULL,
    telefone        VARCHAR(20) NOT NULL,             -- Formato E.164: +5511999999999
    email           VARCHAR(255),
    ativo           BOOLEAN NOT NULL DEFAULT TRUE,
    -- Consentimento LGPD: obrigatório registrar que o cliente aceitou receber mensagens
    consentimento_whatsapp  BOOLEAN NOT NULL DEFAULT FALSE,
    consentimento_data      TIMESTAMPTZ,             -- Quando deu o consentimento
    -- Timestamps
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ,
    -- Um mesmo telefone não pode aparecer duas vezes na mesma loja
    UNIQUE (loja_id, telefone)
);

COMMENT ON TABLE clientes IS 'Clientes finais das lojas. Recebem lembretes via WhatsApp.';
COMMENT ON COLUMN clientes.telefone IS 'Formato E.164 (ex: +5511999999999). Único por loja.';
COMMENT ON COLUMN clientes.consentimento_whatsapp IS 'LGPD: registra se o cliente autorizou o contato.';


-- =============================================================
-- MÓDULO 4: PRODUTOS DA LOJA
-- Os itens que os clientes compram de forma recorrente.
-- =============================================================

CREATE TABLE produtos (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    loja_id         UUID NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
    nome            VARCHAR(255) NOT NULL,
    descricao       TEXT,
    preco           NUMERIC(10, 2),                  -- Opcional, usado para exibir no lembrete
    unidade         VARCHAR(50),                     -- Ex: "kg", "unidade", "pacote"
    ativo           BOOLEAN NOT NULL DEFAULT TRUE,
    -- Timestamps
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

COMMENT ON TABLE produtos IS 'Catálogo de produtos de cada loja.';


-- =============================================================
-- MÓDULO 5: CICLOS DE RECOMPRA
-- O vínculo entre um cliente e um produto, com a frequência definida.
-- Esta é a tabela central do negócio.
-- =============================================================

CREATE TABLE ciclos_recompra (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    loja_id             UUID NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
    cliente_id          UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    produto_id          UUID NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
    -- Configuração do ciclo
    intervalo_dias      INTEGER NOT NULL,             -- Ex: 30 (a cada 30 dias)
    quantidade          NUMERIC(10, 2),               -- Quantidade habitual do pedido
    -- Controle do ciclo
    ativo               BOOLEAN NOT NULL DEFAULT TRUE,
    proxima_notificacao TIMESTAMPTZ,                  -- Quando enviar o próximo lembrete
    ultima_compra       DATE,                         -- Data da última compra registrada
    -- Timestamps
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at          TIMESTAMPTZ
);

COMMENT ON TABLE ciclos_recompra IS 'Vínculo cliente-produto com frequência de recompra. Coração do sistema.';
COMMENT ON COLUMN ciclos_recompra.proxima_notificacao IS 'Calculada automaticamente após cada pedido ou cadastro.';


-- =============================================================
-- MÓDULO 6: LEMBRETES (notificações enviadas via WhatsApp)
-- Cada tentativa de contato com um cliente vira um registro aqui.
-- =============================================================

CREATE TYPE lembrete_status AS ENUM (
    'agendado',     -- Na fila, aguardando envio
    'enviado',      -- Mensagem entregue ao WhatsApp
    'respondido',   -- Cliente interagiu
    'sem_resposta', -- Enviado mas cliente não respondeu no prazo
    'cancelado'     -- Cancelado manualmente ou por mudança no ciclo
);

CREATE TABLE lembretes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    loja_id         UUID NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
    ciclo_id        UUID NOT NULL REFERENCES ciclos_recompra(id) ON DELETE CASCADE,
    -- Controle de envio
    status          lembrete_status NOT NULL DEFAULT 'agendado',
    agendado_para   TIMESTAMPTZ NOT NULL,             -- Quando deve/deveria ser enviado
    enviado_em      TIMESTAMPTZ,                      -- Quando foi efetivamente enviado
    -- Rastreamento de retry
    tentativa       INTEGER NOT NULL DEFAULT 1,       -- 1 = primeiro envio, 2 = retry
    lembrete_pai_id UUID REFERENCES lembretes(id),    -- Referência ao lembrete original (se for retry)
    -- Timestamps
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE lembretes IS 'Cada tentativa de envio de lembrete. Inclui retries.';
COMMENT ON COLUMN lembretes.tentativa IS '1 = envio inicial. 2+ = retentativas.';


-- =============================================================
-- MÓDULO 7: MENSAGENS WHATSAPP
-- Log de todas as mensagens trocadas (enviadas e recebidas).
-- =============================================================

CREATE TYPE mensagem_direcao AS ENUM ('enviada', 'recebida');

CREATE TABLE mensagens_whatsapp (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    loja_id             UUID NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
    lembrete_id         UUID REFERENCES lembretes(id), -- Pode ser NULL para mensagens manuais
    cliente_id          UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    -- Conteúdo
    direcao             mensagem_direcao NOT NULL,
    conteudo            TEXT NOT NULL,
    -- Identificadores externos (360dialog retorna esses IDs)
    whatsapp_message_id VARCHAR(255),                  -- ID da mensagem no WhatsApp
    -- Timestamps
    enviada_em          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE mensagens_whatsapp IS 'Log completo de mensagens enviadas e recebidas via WhatsApp.';


-- =============================================================
-- MÓDULO 8: PEDIDOS
-- Quando o cliente responde "sim" ao lembrete, vira um pedido.
-- =============================================================

CREATE TYPE pedido_status AS ENUM (
    'pendente',     -- Pedido registrado, aguardando confirmação da loja
    'confirmado',   -- Loja confirmou
    'entregue',     -- Entregue/retirado pelo cliente
    'cancelado'     -- Cancelado
);

CREATE TYPE entrega_tipo AS ENUM ('entrega', 'retirada');
CREATE TYPE pagamento_tipo AS ENUM ('dinheiro', 'pix', 'cartao', 'link');

CREATE TABLE pedidos (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    loja_id         UUID NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
    lembrete_id     UUID REFERENCES lembretes(id),
    cliente_id      UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    produto_id      UUID NOT NULL REFERENCES produtos(id),
    -- Detalhes do pedido
    quantidade      NUMERIC(10, 2) NOT NULL,
    preco_unitario  NUMERIC(10, 2),                   -- Preço no momento do pedido (snapshot)
    status          pedido_status NOT NULL DEFAULT 'pendente',
    -- Logística
    tipo_entrega    entrega_tipo,
    tipo_pagamento  pagamento_tipo,
    link_pagamento  VARCHAR(500),                     -- URL do link de pagamento (se aplicável)
    -- Controle de horário
    fora_horario    BOOLEAN NOT NULL DEFAULT FALSE,   -- TRUE se foi pedido fora do expediente
    -- Timestamps
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

COMMENT ON TABLE pedidos IS 'Pedidos gerados a partir de respostas aos lembretes.';
COMMENT ON COLUMN pedidos.preco_unitario IS 'Snapshot do preço no momento do pedido.';
COMMENT ON COLUMN pedidos.fora_horario IS 'Pedido feito fora do horário de funcionamento da loja.';


-- =============================================================
-- MÓDULO 9: CUPONS DE DESCONTO
-- Gerados automaticamente quando cliente opta por sair (opção 3 no fluxo).
-- =============================================================

CREATE TABLE cupons (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    loja_id         UUID NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
    cliente_id      UUID NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    codigo          VARCHAR(50) NOT NULL,
    desconto_pct    NUMERIC(5, 2),                    -- Ex: 10.00 = 10%
    desconto_valor  NUMERIC(10, 2),                   -- Ex: 5.00 = R$ 5,00
    valido_ate      DATE NOT NULL,
    usado           BOOLEAN NOT NULL DEFAULT FALSE,
    usado_em        TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (loja_id, codigo)
);

COMMENT ON TABLE cupons IS 'Cupons gerados para reter clientes que tentaram sair do ciclo.';


-- =============================================================
-- ÍNDICES — para performance nas buscas mais comuns
-- =============================================================

-- Busca de clientes por loja (muito frequente)
CREATE INDEX idx_clientes_loja_id ON clientes(loja_id) WHERE deleted_at IS NULL;

-- Busca de ciclos ativos para agendamento
CREATE INDEX idx_ciclos_loja_id ON ciclos_recompra(loja_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_ciclos_proxima_notificacao ON ciclos_recompra(proxima_notificacao) WHERE ativo = TRUE AND deleted_at IS NULL;

-- Busca de lembretes agendados (a fila de jobs vai usar muito este índice)
CREATE INDEX idx_lembretes_status ON lembretes(status, agendado_para) WHERE status = 'agendado';
CREATE INDEX idx_lembretes_loja_id ON lembretes(loja_id);

-- Busca de mensagens por cliente
CREATE INDEX idx_mensagens_cliente_id ON mensagens_whatsapp(cliente_id);
CREATE INDEX idx_mensagens_loja_id ON mensagens_whatsapp(loja_id);

-- Busca de pedidos por loja e status
CREATE INDEX idx_pedidos_loja_id ON pedidos(loja_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_pedidos_status ON pedidos(loja_id, status) WHERE deleted_at IS NULL;

-- Busca de produtos por loja
CREATE INDEX idx_produtos_loja_id ON produtos(loja_id) WHERE deleted_at IS NULL;


-- =============================================================
-- ROW LEVEL SECURITY (RLS)
-- Garante que cada loja só acessa seus próprios dados,
-- mesmo que haja um bug no código da aplicação.
-- =============================================================

-- Ativa RLS nas tabelas principais
ALTER TABLE clientes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE produtos         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ciclos_recompra  ENABLE ROW LEVEL SECURITY;
ALTER TABLE lembretes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE mensagens_whatsapp ENABLE ROW LEVEL SECURITY;
ALTER TABLE pedidos          ENABLE ROW LEVEL SECURITY;
ALTER TABLE cupons           ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuarios         ENABLE ROW LEVEL SECURITY;

-- Políticas RLS: a aplicação seta a variável "app.loja_id" em cada conexão,
-- e o banco usa essa variável para filtrar os dados automaticamente.

CREATE POLICY loja_isolamento_clientes ON clientes
    USING (loja_id = current_setting('app.loja_id')::UUID);

CREATE POLICY loja_isolamento_produtos ON produtos
    USING (loja_id = current_setting('app.loja_id')::UUID);

CREATE POLICY loja_isolamento_ciclos ON ciclos_recompra
    USING (loja_id = current_setting('app.loja_id')::UUID);

CREATE POLICY loja_isolamento_lembretes ON lembretes
    USING (loja_id = current_setting('app.loja_id')::UUID);

CREATE POLICY loja_isolamento_mensagens ON mensagens_whatsapp
    USING (loja_id = current_setting('app.loja_id')::UUID);

CREATE POLICY loja_isolamento_pedidos ON pedidos
    USING (loja_id = current_setting('app.loja_id')::UUID);

CREATE POLICY loja_isolamento_cupons ON cupons
    USING (loja_id = current_setting('app.loja_id')::UUID);

CREATE POLICY loja_isolamento_usuarios ON usuarios
    USING (loja_id = current_setting('app.loja_id')::UUID);


-- =============================================================
-- FUNÇÃO: atualiza "updated_at" automaticamente
-- Em vez de fazer isso no código, o próprio banco cuida.
-- =============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Aplica o trigger em todas as tabelas que têm updated_at
CREATE TRIGGER trg_lojas_updated_at
    BEFORE UPDATE ON lojas
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_usuarios_updated_at
    BEFORE UPDATE ON usuarios
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_clientes_updated_at
    BEFORE UPDATE ON clientes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_produtos_updated_at
    BEFORE UPDATE ON produtos
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_ciclos_updated_at
    BEFORE UPDATE ON ciclos_recompra
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_lembretes_updated_at
    BEFORE UPDATE ON lembretes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_pedidos_updated_at
    BEFORE UPDATE ON pedidos
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================
-- FIM DO SCHEMA
-- =============================================================
