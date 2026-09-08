-- Migration 016: tabela para armazenar contatos do WhatsApp (para importação)
-- Preenchida via evento contacts.upsert do Baileys durante a sessão ativa.

CREATE TABLE IF NOT EXISTS whatsapp_contatos (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  loja_id    UUID        NOT NULL REFERENCES lojas(id) ON DELETE CASCADE,
  telefone   VARCHAR(20) NOT NULL,
  nome       TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (loja_id, telefone)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_contatos_loja ON whatsapp_contatos(loja_id);

COMMENT ON TABLE whatsapp_contatos IS
  'Contatos sincronizados do WhatsApp via Baileys (contacts.upsert). Usado para importação de clientes.';
