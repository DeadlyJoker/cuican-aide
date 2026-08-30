ALTER TABLE provider_run_journal_events
    ADD COLUMN payload_digest TEXT
    CHECK (
        payload_digest IS NULL
        OR (
            length(payload_digest) = 71
            AND substr(payload_digest, 1, 7) = 'sha256:'
        )
    );

ALTER TABLE provider_run_journal_events
    ADD COLUMN projection_json TEXT
    CHECK (
        projection_json IS NULL
        OR (
            json_valid(projection_json)
            AND json_type(projection_json) = 'object'
        )
    );

CREATE TRIGGER provider_run_event_projection_insert_guard
BEFORE INSERT ON provider_run_journal_events
WHEN (NEW.payload_digest IS NULL) != (NEW.projection_json IS NULL)
BEGIN
    SELECT RAISE(ABORT, 'Provider Run event projection must be complete');
END;

CREATE TRIGGER provider_run_event_projection_update_guard
BEFORE UPDATE OF payload_digest, projection_json ON provider_run_journal_events
WHEN (NEW.payload_digest IS NULL) != (NEW.projection_json IS NULL)
BEGIN
    SELECT RAISE(ABORT, 'Provider Run event projection must be complete');
END;
