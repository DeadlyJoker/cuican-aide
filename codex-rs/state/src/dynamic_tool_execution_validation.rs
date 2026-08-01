use crate::DynamicToolExecutionOperation;
use crate::DynamicToolExecutionRecord;
use crate::DynamicToolExecutionRecordError;
use crate::DynamicToolExecutionRecordErrorKind;
use crate::DynamicToolExecutionResultRecord;
use crate::DynamicToolExecutionTerminalRecord;
use crate::ProviderResourceExecutionLocation;
use crate::ProviderResourceKind;
use crate::durable_workspace_records::validate_workspace_key;
use crate::dynamic_tool_execution_records::dynamic_tool_execution_record_error;
use crate::provider_connection_records::validate_connection_id;
use crate::provider_resource_binding_records::validate_binding_id;

const MAX_ID_BYTES: usize = 255;
const MAX_RESOURCE_ID_BYTES: usize = 512;
const MAX_REVISION_BYTES: usize = 256;
const MAX_PROTOCOL_VERSION_BYTES: usize = 64;
const MAX_INLINE_RESULT_ITEMS: u16 = 16;
const MAX_INLINE_RESULT_BYTES: u32 = 32 * 1024;

pub(crate) fn validate_dynamic_tool_execution_record(
    record: &DynamicToolExecutionRecord,
) -> Result<(), DynamicToolExecutionRecordError> {
    validate_text(&record.call_id, "callId", MAX_ID_BYTES)?;
    validate_hash(&record.action_digest, "actionDigest")?;
    for (value, field) in [
        (&record.access_decision_id, "accessDecisionId"),
        (&record.actor_id, "actorId"),
        (&record.tenant_id, "tenantId"),
        (&record.space_id, "spaceId"),
        (&record.session_id, "sessionId"),
        (&record.trace_id, "traceId"),
        (&record.span_id, "spanId"),
        (&record.thread_id, "threadId"),
        (&record.turn_id, "turnId"),
        (&record.workspace_binding_id, "workspaceBindingId"),
        (&record.workspace_scope_id, "workspaceScopeId"),
        (&record.provider_id, "providerId"),
    ] {
        validate_text(value, field, MAX_ID_BYTES)?;
    }
    validate_optional_text(record.approval_id.as_deref(), "approvalId", MAX_ID_BYTES)?;
    validate_optional_text(
        record.parent_span_id.as_deref(),
        "parentSpanId",
        MAX_ID_BYTES,
    )?;
    if record.parent_span_id.as_deref() == Some(record.span_id.as_str()) {
        return Err(dynamic_tool_execution_record_error(
            "parentSpanId",
            DynamicToolExecutionRecordErrorKind::InconsistentFields,
        ));
    }
    validate_workspace_key(&record.workspace_key).map_err(|_| {
        dynamic_tool_execution_record_error(
            "workspaceKey",
            DynamicToolExecutionRecordErrorKind::InvalidReference,
        )
    })?;
    validate_binding_id(&record.binding_id).map_err(|_| {
        dynamic_tool_execution_record_error(
            "bindingId",
            DynamicToolExecutionRecordErrorKind::InvalidReference,
        )
    })?;
    validate_connection_id(&record.connection_id).map_err(|_| {
        dynamic_tool_execution_record_error(
            "connectionId",
            DynamicToolExecutionRecordErrorKind::InvalidReference,
        )
    })?;
    validate_revision(record.binding_revision, "bindingRevision")?;
    validate_text(
        &record.protocol_version,
        "protocolVersion",
        MAX_PROTOCOL_VERSION_BYTES,
    )?;
    validate_text(&record.resource_id, "resourceId", MAX_RESOURCE_ID_BYTES)?;
    validate_text(
        &record.resource_revision,
        "resourceRevision",
        MAX_REVISION_BYTES,
    )?;
    validate_execution_authority(record)?;
    validate_operation(record)?;
    validate_time(record.created_at, "createdAt")?;
    if record.updated_at < record.created_at {
        return Err(dynamic_tool_execution_record_error(
            "updatedAt",
            DynamicToolExecutionRecordErrorKind::OutOfRange,
        ));
    }
    validate_terminal(record)?;
    validate_hash(&record.claim_hash, "claimHash")?;
    if record.claim_hash != record.canonical_claim_hash() {
        return Err(dynamic_tool_execution_record_error(
            "claimHash",
            DynamicToolExecutionRecordErrorKind::DigestMismatch,
        ));
    }
    validate_hash(&record.record_hash, "recordHash")?;
    if record.record_hash != record.canonical_hash() {
        return Err(dynamic_tool_execution_record_error(
            "recordHash",
            DynamicToolExecutionRecordErrorKind::DigestMismatch,
        ));
    }
    Ok(())
}

pub(crate) fn validate_dynamic_tool_execution_call_id(
    call_id: &str,
) -> Result<(), DynamicToolExecutionRecordError> {
    validate_text(call_id, "callId", MAX_ID_BYTES)
}

fn validate_execution_authority(
    record: &DynamicToolExecutionRecord,
) -> Result<(), DynamicToolExecutionRecordError> {
    match (
        &record.credential_id,
        record.credential_revision,
        &record.provider_identity_binding_id,
        record.provider_identity_binding_revision,
        &record.provider_subject,
        &record.provider_tenant_id,
        &record.provider_space_id,
        record.execution_location,
    ) {
        (
            Some(credential_id),
            Some(credential_revision),
            Some(identity_binding_id),
            Some(identity_binding_revision),
            Some(provider_subject),
            Some(provider_tenant_id),
            Some(provider_space_id),
            ProviderResourceExecutionLocation::Provider,
        ) => {
            validate_text(credential_id, "credentialId", MAX_ID_BYTES)?;
            validate_revision(credential_revision, "credentialRevision")?;
            validate_text(
                identity_binding_id,
                "providerIdentityBindingId",
                MAX_ID_BYTES,
            )?;
            validate_revision(identity_binding_revision, "providerIdentityBindingRevision")?;
            validate_text(provider_subject, "providerSubject", MAX_ID_BYTES)?;
            validate_text(provider_tenant_id, "providerTenantId", MAX_ID_BYTES)?;
            validate_text(provider_space_id, "providerSpaceId", MAX_ID_BYTES)
        }
        _ => Err(dynamic_tool_execution_record_error(
            "executionAuthority",
            DynamicToolExecutionRecordErrorKind::InconsistentFields,
        )),
    }
}

fn validate_operation(
    record: &DynamicToolExecutionRecord,
) -> Result<(), DynamicToolExecutionRecordError> {
    if matches!(
        (record.resource_kind, record.operation),
        (
            ProviderResourceKind::McpTool,
            DynamicToolExecutionOperation::Call
        ) | (
            ProviderResourceKind::KnowledgeBase,
            DynamicToolExecutionOperation::Search
        )
    ) {
        Ok(())
    } else {
        Err(dynamic_tool_execution_record_error(
            "operation",
            DynamicToolExecutionRecordErrorKind::InconsistentFields,
        ))
    }
}

fn validate_terminal(
    record: &DynamicToolExecutionRecord,
) -> Result<(), DynamicToolExecutionRecordError> {
    match (&record.terminal, &record.audit_event_id) {
        (DynamicToolExecutionTerminalRecord::Claimed, None)
            if record.updated_at == record.created_at =>
        {
            Ok(())
        }
        (DynamicToolExecutionTerminalRecord::Succeeded(result), Some(event_id)) => {
            validate_text(event_id, "auditEventId", MAX_ID_BYTES)?;
            validate_result(result)
        }
        (
            DynamicToolExecutionTerminalRecord::Failed(_)
            | DynamicToolExecutionTerminalRecord::Unknown(_),
            Some(event_id),
        ) => validate_text(event_id, "auditEventId", MAX_ID_BYTES),
        _ => Err(dynamic_tool_execution_record_error(
            "terminal",
            DynamicToolExecutionRecordErrorKind::InconsistentFields,
        )),
    }
}

fn validate_result(
    result: &DynamicToolExecutionResultRecord,
) -> Result<(), DynamicToolExecutionRecordError> {
    match result {
        DynamicToolExecutionResultRecord::Inline {
            item_count,
            byte_len,
            sha256,
        } => {
            if *item_count > MAX_INLINE_RESULT_ITEMS
                || *byte_len == 0
                || *byte_len > MAX_INLINE_RESULT_BYTES
            {
                return Err(dynamic_tool_execution_record_error(
                    "result",
                    DynamicToolExecutionRecordErrorKind::OutOfRange,
                ));
            }
            validate_hash(sha256, "resultSha256")
        }
        DynamicToolExecutionResultRecord::Artifact {
            artifact_id,
            revision,
        } => {
            validate_text(artifact_id, "artifactId", MAX_ID_BYTES)?;
            validate_revision(*revision, "artifactRevision")
        }
    }
}

fn validate_text(
    value: &str,
    field: &'static str,
    max_bytes: usize,
) -> Result<(), DynamicToolExecutionRecordError> {
    if value.trim().is_empty() || value.chars().any(char::is_control) {
        return Err(dynamic_tool_execution_record_error(
            field,
            DynamicToolExecutionRecordErrorKind::Empty,
        ));
    }
    if value.len() > max_bytes {
        return Err(dynamic_tool_execution_record_error(
            field,
            DynamicToolExecutionRecordErrorKind::TooLong,
        ));
    }
    Ok(())
}

fn validate_optional_text(
    value: Option<&str>,
    field: &'static str,
    max_bytes: usize,
) -> Result<(), DynamicToolExecutionRecordError> {
    value.map_or(Ok(()), |value| validate_text(value, field, max_bytes))
}

fn validate_revision(
    value: u64,
    field: &'static str,
) -> Result<(), DynamicToolExecutionRecordError> {
    if value == 0 || i64::try_from(value).is_err() {
        return Err(dynamic_tool_execution_record_error(
            field,
            DynamicToolExecutionRecordErrorKind::OutOfRange,
        ));
    }
    Ok(())
}

fn validate_time(value: i64, field: &'static str) -> Result<(), DynamicToolExecutionRecordError> {
    if value < 0 {
        return Err(dynamic_tool_execution_record_error(
            field,
            DynamicToolExecutionRecordErrorKind::OutOfRange,
        ));
    }
    Ok(())
}

fn validate_hash(value: &str, field: &'static str) -> Result<(), DynamicToolExecutionRecordError> {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return Err(dynamic_tool_execution_record_error(
            field,
            DynamicToolExecutionRecordErrorKind::InvalidHash,
        ));
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(dynamic_tool_execution_record_error(
            field,
            DynamicToolExecutionRecordErrorKind::InvalidHash,
        ));
    }
    Ok(())
}
