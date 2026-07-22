-- =============================================================
-- Migration 005 — Painel Admin
-- Rodar em produção ANTES do deploy do novo código.
-- =============================================================

-- 1. Coluna role em usuarios: 'admin' (dono do sistema) ou 'lojista' (padrão)
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'lojista';

-- 2. Torna loja_id nullable — usuários admin não pertencem a uma loja
ALTER TABLE usuarios ALTER COLUMN loja_id DROP NOT NULL;

-- 3. Campos de assinatura na loja
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS status_assinatura TEXT NOT NULL DEFAULT 'ativa';
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS valor_mensalidade NUMERIC(10,2);
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS proximo_vencimento DATE;

-- 4. Status de conexão WhatsApp por loja (atualizado pelo Baileys ao conectar/desconectar)
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS wa_status TEXT NOT NULL DEFAULT 'desconectado';
ALTER TABLE lojas ADD COLUMN IF NOT EXISTS wa_atualizado_em TIMESTAMPTZ;

-- 5. Marca o usuário admin do sistema (preserva loja_id — admin pode ser lojista também)
UPDATE usuarios
SET role = 'admin'
WHERE email = 'gessicabarbosa.gt@gmail.com';
