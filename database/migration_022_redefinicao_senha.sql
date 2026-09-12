-- Migration 022: redefinição de senha por e-mail
-- Dois campos de token em usuarios + flag de e-mail confirmado.
-- Usados pelos endpoints POST /auth/esqueci-senha e POST /auth/redefinir-senha,
-- e pelo fluxo de criação de loja (lojista define própria senha sem o admin saber).

ALTER TABLE usuarios
  ADD COLUMN IF NOT EXISTS token_redefinicao TEXT,
  ADD COLUMN IF NOT EXISTS token_expira_em   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS email_confirmado  BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN usuarios.token_redefinicao IS 'SHA-256 do token de redefinição/definição de senha (nunca o token puro).';
COMMENT ON COLUMN usuarios.token_expira_em   IS 'Expiração do token — 1 hora após geração.';
COMMENT ON COLUMN usuarios.email_confirmado  IS 'TRUE após o usuário redefinir/definir senha pelo link de e-mail.';
