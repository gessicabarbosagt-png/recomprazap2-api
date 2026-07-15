-- =============================================================
-- Migration 004 — lida_em em mensagens + confirmar_leitura_wa em lojas
-- =============================================================

ALTER TABLE mensagens_whatsapp
  ADD COLUMN IF NOT EXISTS lida_em TIMESTAMPTZ;

ALTER TABLE lojas
  ADD COLUMN IF NOT EXISTS confirmar_leitura_wa BOOLEAN NOT NULL DEFAULT FALSE;

-- Índice para busca rápida de mensagens não lidas por conversa
CREATE INDEX IF NOT EXISTS idx_mensagens_nao_lidas
  ON mensagens_whatsapp (loja_id, cliente_id)
  WHERE direcao = 'recebida' AND lida_em IS NULL AND deleted_at IS NULL;
