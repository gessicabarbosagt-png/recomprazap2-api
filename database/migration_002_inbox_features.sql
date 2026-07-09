-- =============================================================
-- Migration 002 — Inbox Features
-- =============================================================

-- Feature 1: origem column (sistema | painel | celular)
ALTER TABLE mensagens_whatsapp
  ADD COLUMN IF NOT EXISTS origem VARCHAR(20);

-- Feature 1: unique index for echo deduplication
CREATE UNIQUE INDEX IF NOT EXISTS idx_mensagens_dedup
  ON mensagens_whatsapp (loja_id, whatsapp_message_id)
  WHERE whatsapp_message_id IS NOT NULL;

-- Feature 2: soft-delete conversations
ALTER TABLE mensagens_whatsapp
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_mensagens_not_deleted
  ON mensagens_whatsapp (loja_id, cliente_id)
  WHERE deleted_at IS NULL;

-- Feature 3: lead origin tracking on clientes
ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS origem_lead TEXT;

ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS origem_detalhe JSONB;

-- Feature 3: tracking codes table
CREATE TABLE IF NOT EXISTS codigos_origem (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  loja_id     UUID NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  codigo      VARCHAR(100) NOT NULL,
  rotulo      VARCHAR(255) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (loja_id, codigo)
);

CREATE INDEX IF NOT EXISTS idx_codigos_origem_loja ON codigos_origem (loja_id);
