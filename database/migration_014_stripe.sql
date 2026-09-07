-- Migration 014: Adiciona colunas Stripe em lojas e planos_catalogo
-- As colunas antigas do Mercado Pago (mp_subscription_id, mp_payment_method,
-- mp_card_last_four) permanecem intactas para preservar histórico.

ALTER TABLE lojas
  ADD COLUMN IF NOT EXISTS stripe_customer_id      TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id  TEXT;

ALTER TABLE planos_catalogo
  ADD COLUMN IF NOT EXISTS stripe_price_id TEXT;
