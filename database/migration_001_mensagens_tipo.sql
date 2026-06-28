-- Adiciona coluna tipo em mensagens_whatsapp (ausente no schema original)
ALTER TABLE mensagens_whatsapp
  ADD COLUMN IF NOT EXISTS tipo VARCHAR(20);
