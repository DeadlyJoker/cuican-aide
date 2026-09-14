export function sqliteRunOutputSchemaSql(): string {
  return `CREATE TABLE IF NOT EXISTS run_output_receipts (
    tenant_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    segment_id TEXT NOT NULL,
    segment_sequence INTEGER NOT NULL CHECK (segment_sequence BETWEEN 1 AND 9007199254740991),
    run_sequence INTEGER NOT NULL CHECK (run_sequence BETWEEN 1 AND 9007199254740991),
    fingerprint TEXT NOT NULL,
    PRIMARY KEY (run_id, segment_id, segment_sequence),
    UNIQUE (run_id, run_sequence),
    FOREIGN KEY (tenant_id, run_id) REFERENCES run_snapshots(tenant_id, run_id) ON DELETE CASCADE,
    FOREIGN KEY (run_id, run_sequence) REFERENCES run_events(run_id, sequence) ON DELETE CASCADE
  ) STRICT;
  CREATE TRIGGER IF NOT EXISTS run_output_receipt_duplicate_guard
  BEFORE INSERT ON run_events
  WHEN json_extract(NEW.event_json, '$.type') = 'model.output.delta' AND EXISTS (
    SELECT 1 FROM run_output_receipts
    WHERE run_id = NEW.run_id
      AND segment_id = json_extract(NEW.event_json, '$.data.segmentId')
      AND segment_sequence = json_extract(NEW.event_json, '$.data.segmentSequence')
  )
  BEGIN SELECT RAISE(ABORT, 'run_output_replay_requires_stream_append'); END;`;
}
