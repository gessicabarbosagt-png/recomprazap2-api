-- Migration 013: quantidade e unidade por produto no ciclo (nullable, não quebra ciclos existentes)
ALTER TABLE ciclo_produtos
  ADD COLUMN IF NOT EXISTS quantidade numeric,
  ADD COLUMN IF NOT EXISTS unidade text CHECK (unidade IN ('kg', 'grama', 'pacote', 'unidade'));
