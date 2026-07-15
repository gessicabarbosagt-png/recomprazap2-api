-- =============================================================
-- Migration 003 — WhatsApp pushName (whatsapp_nome)
-- =============================================================

ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS whatsapp_nome VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_clientes_whatsapp_nome
  ON clientes (loja_id, whatsapp_nome)
  WHERE whatsapp_nome IS NOT NULL;
