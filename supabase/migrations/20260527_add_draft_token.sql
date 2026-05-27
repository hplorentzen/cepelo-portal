-- Add a draft_token column to the quotes table.
-- Draft quotes (status='draft') are accessible to the CEPELO seller via
-- /seller/[draft_token] to fill in dealer/customer details before sending.

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS draft_token TEXT UNIQUE;

-- Index for fast lookup when the seller opens the form link.
CREATE INDEX IF NOT EXISTS quotes_draft_token_idx ON quotes (draft_token);
