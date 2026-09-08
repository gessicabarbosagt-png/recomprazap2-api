-- Migration 015: produtos — renomear unidade→especificacao, adicionar estoque
-- IMPORTANTE: migration_013 (ciclo_produtos quantidade/unidade) DEVE ser rodada antes ou junto.

-- 1. Renomeia unidade para especificacao no catálogo de produtos
ALTER TABLE produtos RENAME COLUMN unidade TO especificacao;

-- 2. Adiciona campo de estoque (nullable — nenhum produto existente é forçado a ter estoque)
ALTER TABLE produtos
  ADD COLUMN IF NOT EXISTS estoque numeric CHECK (estoque >= 0);

COMMENT ON COLUMN produtos.especificacao IS 'Texto livre descrevendo a característica/variação do produto, ex: "1kg", "500g", "pacote com 6".';
COMMENT ON COLUMN produtos.estoque IS 'Quantidade em estoque. NULL = não controlado. Mínimo 0 (nunca negativo).';
