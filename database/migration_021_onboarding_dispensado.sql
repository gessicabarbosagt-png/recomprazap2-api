-- Migration 021: onboarding_dispensado em lojas
-- Permite encerrar manualmente o checklist "Comece por aqui" de uma loja específica.
-- Uso: ação administrativa direta (via admin ou banco), não exposta ao lojista comum.

ALTER TABLE lojas
  ADD COLUMN IF NOT EXISTS onboarding_dispensado BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN lojas.onboarding_dispensado IS
  'TRUE = checklist de onboarding considerado completo independente dos critérios reais. '
  'Usado para contas de demonstração ou lojas que dispensaram o fluxo de ativação.';
