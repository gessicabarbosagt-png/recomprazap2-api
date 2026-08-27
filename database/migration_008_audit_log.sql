-- =============================================================
-- Migration 008 — Tabela de auditoria de ações administrativas
-- Rodar em produção ANTES do deploy do novo código.
-- =============================================================

CREATE TABLE IF NOT EXISTS audit_log (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id         TEXT        NOT NULL,
  acao             TEXT        NOT NULL,
  loja_afetada_id  UUID,
  detalhes         JSONB,
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_admin_id        ON audit_log(admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_criado_em       ON audit_log(criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_loja_afetada_id ON audit_log(loja_afetada_id);
