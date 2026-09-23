-- Add HubSpot integration columns to the quotes table.
-- hubspot_deal_id: the HubSpot deal this quote is linked to (nullable, no unique
--   constraint — multiple quote revisions may share the same deal).
-- hubspot_sync_error: last sync error message, cleared on success.

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS hubspot_deal_id    TEXT,
  ADD COLUMN IF NOT EXISTS hubspot_sync_error TEXT;

CREATE INDEX IF NOT EXISTS quotes_hubspot_deal_id_idx ON quotes (hubspot_deal_id);
