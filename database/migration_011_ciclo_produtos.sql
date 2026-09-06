-- Migration 011: ciclo_produtos — muitos-para-muitos entre ciclos e produtos
-- Preserva produto_id legado para rollback seguro; pode ser removido após validação.

CREATE TABLE IF NOT EXISTS ciclo_produtos (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  ciclo_id   UUID        NOT NULL REFERENCES ciclos_recompra(id) ON DELETE CASCADE,
  produto_id UUID        NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ciclo_id, produto_id)
);

CREATE INDEX IF NOT EXISTS idx_ciclo_produtos_ciclo    ON ciclo_produtos(ciclo_id);
CREATE INDEX IF NOT EXISTS idx_ciclo_produtos_produto  ON ciclo_produtos(produto_id);

COMMENT ON TABLE ciclo_produtos IS
  'Junção N:N entre ciclos_recompra e produtos. Um ciclo pode ter vários produtos; '
  'o lembrete menciona todos eles na mensagem.';

-- Popula a partir do produto_id legado (não deletados e com produto_id válido)
INSERT INTO ciclo_produtos (ciclo_id, produto_id)
SELECT id, produto_id
FROM ciclos_recompra
WHERE produto_id IS NOT NULL
  AND deleted_at IS NULL
ON CONFLICT (ciclo_id, produto_id) DO NOTHING;
