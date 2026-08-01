CREATE TABLE dynamic_tool_execution_journal (
    call_id TEXT PRIMARY KEY CHECK(length(call_id) BETWEEN 1 AND 255),
    action_digest TEXT NOT NULL CHECK(
        length(action_digest) = 71
        AND substr(action_digest, 1, 7) = 'sha256:'
        AND substr(action_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    access_decision_id TEXT NOT NULL CHECK(length(access_decision_id) BETWEEN 1 AND 255),
    approval_id TEXT CHECK(approval_id IS NULL OR length(approval_id) BETWEEN 1 AND 255),
    actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 255),
    tenant_id TEXT NOT NULL CHECK(length(tenant_id) BETWEEN 1 AND 255),
    space_id TEXT NOT NULL CHECK(length(space_id) BETWEEN 1 AND 255),
    session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 255),
    trace_id TEXT NOT NULL CHECK(length(trace_id) BETWEEN 1 AND 255),
    span_id TEXT NOT NULL CHECK(length(span_id) BETWEEN 1 AND 255),
    parent_span_id TEXT CHECK(parent_span_id IS NULL OR length(parent_span_id) BETWEEN 1 AND 255),
    thread_id TEXT NOT NULL CHECK(length(thread_id) BETWEEN 1 AND 255),
    turn_id TEXT NOT NULL CHECK(length(turn_id) BETWEEN 1 AND 255),
    workspace_key TEXT NOT NULL CHECK(length(workspace_key) BETWEEN 1 AND 255),
    workspace_binding_id TEXT NOT NULL CHECK(length(workspace_binding_id) BETWEEN 1 AND 255),
    workspace_scope TEXT NOT NULL CHECK(workspace_scope IN ('conversation', 'office', 'workflow', 'automation')),
    workspace_scope_id TEXT NOT NULL CHECK(length(workspace_scope_id) BETWEEN 1 AND 255),
    binding_id TEXT NOT NULL CHECK(length(binding_id) BETWEEN 1 AND 255),
    binding_revision INTEGER NOT NULL CHECK(binding_revision > 0),
    connection_id TEXT NOT NULL CHECK(length(connection_id) BETWEEN 1 AND 255),
    provider_id TEXT NOT NULL CHECK(length(provider_id) BETWEEN 1 AND 255),
    protocol_version TEXT NOT NULL CHECK(length(protocol_version) BETWEEN 1 AND 64),
    resource_kind TEXT NOT NULL CHECK(resource_kind IN ('mcpTool', 'knowledgeBase')),
    resource_id TEXT NOT NULL CHECK(length(resource_id) BETWEEN 1 AND 512),
    resource_revision TEXT NOT NULL CHECK(length(resource_revision) BETWEEN 1 AND 256),
    execution_location TEXT NOT NULL CHECK(execution_location IN ('localNode', 'provider')),
    credential_id TEXT CHECK(credential_id IS NULL OR length(credential_id) BETWEEN 1 AND 255),
    credential_revision INTEGER CHECK(credential_revision IS NULL OR credential_revision > 0),
    provider_identity_binding_id TEXT CHECK(
        provider_identity_binding_id IS NULL
        OR length(provider_identity_binding_id) BETWEEN 1 AND 255
    ),
    provider_identity_binding_revision INTEGER CHECK(
        provider_identity_binding_revision IS NULL OR provider_identity_binding_revision > 0
    ),
    provider_subject TEXT CHECK(provider_subject IS NULL OR length(provider_subject) BETWEEN 1 AND 255),
    provider_tenant_id TEXT CHECK(
        provider_tenant_id IS NULL OR length(provider_tenant_id) BETWEEN 1 AND 255
    ),
    provider_space_id TEXT CHECK(
        provider_space_id IS NULL OR length(provider_space_id) BETWEEN 1 AND 255
    ),
    operation TEXT NOT NULL CHECK(operation IN ('call', 'search')),
    status TEXT NOT NULL CHECK(status IN ('claimed', 'succeeded', 'failed', 'unknown')),
    terminal_code TEXT CHECK(terminal_code IS NULL OR terminal_code IN (
        'rejected', 'executionFailed', 'timeout', 'adapterUnavailable', 'invalidResponse'
    )),
    result_kind TEXT NOT NULL CHECK(result_kind IN ('none', 'inline', 'artifact')),
    result_item_count INTEGER CHECK(result_item_count IS NULL OR result_item_count BETWEEN 0 AND 16),
    result_byte_len INTEGER CHECK(result_byte_len IS NULL OR result_byte_len BETWEEN 1 AND 32768),
    result_digest TEXT CHECK(
        result_digest IS NULL
        OR (
            length(result_digest) = 71
            AND substr(result_digest, 1, 7) = 'sha256:'
            AND substr(result_digest, 8) NOT GLOB '*[^0-9a-f]*'
        )
    ),
    artifact_id TEXT CHECK(artifact_id IS NULL OR length(artifact_id) BETWEEN 1 AND 255),
    artifact_revision INTEGER CHECK(artifact_revision IS NULL OR artifact_revision > 0),
    audit_event_id TEXT UNIQUE REFERENCES platform_audit_events(event_id),
    claim_hash TEXT NOT NULL CHECK(
        length(claim_hash) = 71
        AND substr(claim_hash, 1, 7) = 'sha256:'
        AND substr(claim_hash, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    record_hash TEXT NOT NULL CHECK(
        length(record_hash) = 71
        AND substr(record_hash, 1, 7) = 'sha256:'
        AND substr(record_hash, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
    FOREIGN KEY(binding_id) REFERENCES provider_resource_bindings(binding_id),
    FOREIGN KEY(provider_identity_binding_id) REFERENCES provider_identity_bindings(binding_id),
    CHECK(parent_span_id IS NULL OR parent_span_id != span_id),
    CHECK(
        (
            credential_id IS NULL
            AND credential_revision IS NULL
            AND provider_identity_binding_id IS NULL
            AND provider_identity_binding_revision IS NULL
            AND provider_subject IS NULL
            AND provider_tenant_id IS NULL
            AND provider_space_id IS NULL
            AND execution_location = 'localNode'
        )
        OR
        (
            credential_id IS NOT NULL
            AND credential_revision IS NOT NULL
            AND provider_identity_binding_id IS NOT NULL
            AND provider_identity_binding_revision IS NOT NULL
            AND provider_subject IS NOT NULL
            AND provider_tenant_id IS NOT NULL
            AND provider_space_id IS NOT NULL
            AND execution_location = 'provider'
        )
    ),
    CHECK(
        (resource_kind = 'mcpTool' AND operation = 'call')
        OR
        (resource_kind = 'knowledgeBase' AND operation = 'search')
    ),
    CHECK(
        (
            status = 'claimed'
            AND terminal_code IS NULL
            AND result_kind = 'none'
            AND result_item_count IS NULL
            AND result_byte_len IS NULL
            AND result_digest IS NULL
            AND artifact_id IS NULL
            AND artifact_revision IS NULL
            AND audit_event_id IS NULL
            AND updated_at = created_at
        )
        OR
        (
            status = 'succeeded'
            AND terminal_code IS NULL
            AND audit_event_id IS NOT NULL
            AND (
                (
                    result_kind = 'inline'
                    AND result_item_count IS NOT NULL
                    AND result_byte_len IS NOT NULL
                    AND result_digest IS NOT NULL
                    AND artifact_id IS NULL
                    AND artifact_revision IS NULL
                )
                OR
                (
                    result_kind = 'artifact'
                    AND result_item_count IS NULL
                    AND result_byte_len IS NULL
                    AND result_digest IS NULL
                    AND artifact_id IS NOT NULL
                    AND artifact_revision IS NOT NULL
                )
            )
        )
        OR
        (
            status = 'failed'
            AND terminal_code IN ('rejected', 'executionFailed')
            AND result_kind = 'none'
            AND result_item_count IS NULL
            AND result_byte_len IS NULL
            AND result_digest IS NULL
            AND artifact_id IS NULL
            AND artifact_revision IS NULL
            AND audit_event_id IS NOT NULL
        )
        OR
        (
            status = 'unknown'
            AND terminal_code IN ('timeout', 'adapterUnavailable', 'invalidResponse')
            AND result_kind = 'none'
            AND result_item_count IS NULL
            AND result_byte_len IS NULL
            AND result_digest IS NULL
            AND artifact_id IS NULL
            AND artifact_revision IS NULL
            AND audit_event_id IS NOT NULL
        )
    )
);

CREATE INDEX dynamic_tool_execution_journal_recovery
ON dynamic_tool_execution_journal(status, updated_at, call_id)
WHERE status = 'claimed';
