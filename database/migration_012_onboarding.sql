-- Migration 012: campo onboarding_teste_enviado em lojas
-- Controla se o lojista já enviou o lembrete de teste (aha moment do onboarding).

ALTER TABLE lojas
  ADD COLUMN IF NOT EXISTS onboarding_teste_enviado BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN lojas.onboarding_teste_enviado IS
  'TRUE após o primeiro envio bem-sucedido do lembrete de teste via /onboarding/enviar-teste.';
