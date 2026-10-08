-- Enforce that org_settings can never hold more than one row.
-- The application always reads/writes id = 1.
ALTER TABLE "org_settings"
  ADD CONSTRAINT "org_settings_singleton" CHECK (id = 1);
