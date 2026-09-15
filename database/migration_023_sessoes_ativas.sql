-- Revogação real de sessão JWT via tabela de sessões ativas.
-- Cada login gera um jti (UUID único) gravado aqui.
-- Logout marca revogado_em; JwtStrategy rejeita tokens com jti revogado.
-- Sessões com expires_at < NOW() são limpas pelo cron horário do agendador.

CREATE TABLE IF NOT EXISTS sessoes_ativas (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id  UUID        NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  jti         UUID        NOT NULL UNIQUE,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL,
  revogado_em TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessoes_jti     ON sessoes_ativas (jti);
CREATE INDEX IF NOT EXISTS idx_sessoes_expires ON sessoes_ativas (expires_at);
