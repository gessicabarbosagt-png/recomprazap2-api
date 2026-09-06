-- Migration 010: horario_envio em ciclos_recompra
-- Permite configurar o horário preferido de disparo automático por ciclo.
-- Ações manuais do lojista continuam funcionando a qualquer hora.

ALTER TABLE ciclos_recompra
  ADD COLUMN IF NOT EXISTS horario_envio TIME DEFAULT '09:00';

COMMENT ON COLUMN ciclos_recompra.horario_envio IS
  'Horário mínimo (BRT) para disparo automático. NULL = sem restrição. Ações manuais ignoram este campo.';
