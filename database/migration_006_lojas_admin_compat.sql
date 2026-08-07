-- =============================================================
-- Migration 006 — Compatibilidade lojas legadas com painel admin
-- Garante que lojas criadas antes do painel admin tenham todos
-- os campos exigidos pela query listarLojas e pelo lojista service.
-- Idempotente: seguro rodar mais de uma vez.
-- =============================================================

-- confirmar_leitura_wa: controla se abre conversa com ✓✓ azul.
-- Estava sendo lido/gravado sem nunca ter sido criado via migration.
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS confirmar_leitura_wa BOOLEAN NOT NULL DEFAULT FALSE;

-- status_assinatura, wa_status, wa_atualizado_em, valor_mensalidade, proximo_vencimento
-- já foram adicionados via migration_005. As linhas abaixo são safety net caso
-- a migration_005 não tenha sido aplicada no banco de algum ambiente.
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS status_assinatura   TEXT        NOT NULL DEFAULT 'ativa';
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS wa_status           TEXT        NOT NULL DEFAULT 'desconectado';
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS wa_atualizado_em    TIMESTAMPTZ;
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS valor_mensalidade   NUMERIC(10,2);
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS proximo_vencimento  DATE;

-- Garante que lojas existentes (ex: BeeUp Pizzarias) tenham valores corretos
-- para os campos que determinam visibilidade no painel admin.
-- ativa já tem DEFAULT TRUE na criação; este UPDATE cobre edge-case de NULL.
UPDATE lojas
SET
  ativa             = TRUE,
  status_assinatura = COALESCE(status_assinatura, 'ativa'),
  wa_status         = COALESCE(wa_status, 'desconectado'),
  plano             = COALESCE(plano, 'gratuito')
WHERE deleted_at IS NULL;
