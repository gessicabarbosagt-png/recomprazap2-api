-- 007 — Converte ciclos_recompra.quantidade de NUMERIC(10,2) para TEXT
-- Permite valores como "2 kg", "1 pacote", "500g", "3 unidades" diretamente no campo
-- Valores numéricos existentes são convertidos (ex: 2.00 → "2", 1.50 → "1.50")

ALTER TABLE ciclos_recompra
  ALTER COLUMN quantidade TYPE TEXT
  USING CASE
    WHEN quantidade IS NULL THEN NULL
    WHEN quantidade = TRUNC(quantidade) THEN TRUNC(quantidade)::INTEGER::TEXT
    ELSE quantidade::TEXT
  END;

COMMENT ON COLUMN ciclos_recompra.quantidade IS
  'Quantidade como texto livre. Ex: "2 kg", "1 pacote", "500g". Aparece diretamente na mensagem de lembrete.';
