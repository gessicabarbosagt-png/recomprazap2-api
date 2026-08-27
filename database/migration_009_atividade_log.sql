-- Migration 009: tabela de atividade do lojista
-- Registra ações manuais relevantes do lojista (não automações do sistema)

CREATE TABLE IF NOT EXISTS atividade_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id     UUID        NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  tipo        TEXT        NOT NULL,       -- 'cliente_criado', 'pedido_confirmado', etc.
  descricao   TEXT        NOT NULL,       -- texto curto legível para o dashboard
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_atividade_log_loja_id   ON atividade_log(loja_id);
CREATE INDEX IF NOT EXISTS idx_atividade_log_criado_em ON atividade_log(loja_id, criado_em DESC);
