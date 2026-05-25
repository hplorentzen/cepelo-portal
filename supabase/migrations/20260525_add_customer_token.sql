-- Add a separate customer_token column to the quotes table.
-- This allows dealer and customer views to have independent, unguessable URLs.
-- Dealers access /quote/<token>, customers access /quote/<customer_token>.

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS customer_token TEXT UNIQUE;

-- Index for fast lookup when a customer opens their link.
CREATE INDEX IF NOT EXISTS quotes_customer_token_idx ON quotes (customer_token);
