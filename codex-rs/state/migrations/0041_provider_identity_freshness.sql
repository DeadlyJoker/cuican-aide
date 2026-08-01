ALTER TABLE provider_identity_bindings
ADD COLUMN source_fresh_until INTEGER NOT NULL DEFAULT 0
CHECK(source_fresh_until >= 0);
