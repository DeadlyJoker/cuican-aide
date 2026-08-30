use serde_json::Value;
use sqlx::Row;

use crate::DynamicToolExecutionFailureCode;
use crate::DynamicToolExecutionRecord;
use crate::DynamicToolExecutionResultRecord;
use crate::DynamicToolExecutionTerminalRecord;
use crate::DynamicToolExecutionUnknownCode;
use crate::PlatformAuditEventRecord;

use super::artifacts::storage_mapping::audit_event_hash;

pub(super) enum DynamicToolAuditIdentity {
    Absent,
    ExistingSame,
    Conflict,
}

pub(super) async fn dynamic_tool_audit_identity(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    event: &PlatformAuditEventRecord,
) -> anyhow::Result<DynamicToolAuditIdentity> {
    let rows = sqlx::query(
        r#"
SELECT event_id, idempotency_key, event_hash, event_type, metadata_json,
       payload_id, occurred_at
FROM platform_audit_events
WHERE event_id = ? OR idempotency_key = ?
        "#,
    )
    .bind(&event.event_id)
    .bind(&event.idempotency_key)
    .fetch_all(&mut **tx)
    .await?;
    if rows.is_empty() {
        return Ok(DynamicToolAuditIdentity::Absent);
    }
    if rows.len() != 1 {
        return Ok(DynamicToolAuditIdentity::Conflict);
    }
    let row = &rows[0];
    let stored = PlatformAuditEventRecord {
        event_id: row.try_get("event_id")?,
        idempotency_key: row.try_get("idempotency_key")?,
        event_type: row.try_get("event_type")?,
        metadata_json: row.try_get("metadata_json")?,
        payload_id: row.try_get("payload_id")?,
        occurred_at: row.try_get("occurred_at")?,
    };
    stored.validate()?;
    if stored == *event && row.try_get::<&str, _>("event_hash")? == audit_event_hash(&stored) {
        Ok(DynamicToolAuditIdentity::ExistingSame)
    } else {
        Ok(DynamicToolAuditIdentity::Conflict)
    }
}

pub(super) async fn dynamic_tool_audit_matches_completion(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    completed: &DynamicToolExecutionRecord,
    event: &PlatformAuditEventRecord,
) -> anyhow::Result<bool> {
    if event.event_type != "externalAction"
        || event.payload_id.is_some()
        || event.occurred_at != completed.updated_at
        || completed.audit_event_id.as_deref() != Some(event.event_id.as_str())
    {
        return Ok(false);
    }
    let metadata: Value = serde_json::from_str(&event.metadata_json)?;
    if !common_audit_fields_match(completed, event, &metadata)
        || !outcome_matches(completed, &metadata)
        || !approval_matches(completed, &metadata)
        || !artifacts_match(completed, &metadata)
    {
        return Ok(false);
    }
    match &completed.terminal {
        DynamicToolExecutionTerminalRecord::Succeeded(
            DynamicToolExecutionResultRecord::Artifact {
                artifact_id,
                revision,
            },
        ) => artifact_exists(tx, artifact_id, *revision).await,
        DynamicToolExecutionTerminalRecord::Claimed
        | DynamicToolExecutionTerminalRecord::Succeeded(
            DynamicToolExecutionResultRecord::Inline { .. },
        )
        | DynamicToolExecutionTerminalRecord::Failed(_)
        | DynamicToolExecutionTerminalRecord::Unknown(_) => Ok(true),
    }
}

fn common_audit_fields_match(
    completed: &DynamicToolExecutionRecord,
    event: &PlatformAuditEventRecord,
    metadata: &Value,
) -> bool {
    string_at(metadata, "/eventId") == Some(event.event_id.as_str())
        && string_at(metadata, "/idempotencyKey") == Some(event.idempotency_key.as_str())
        && string_at(metadata, "/action") == Some("externalAction")
        && integer_at(metadata, "/occurredAt") == Some(completed.updated_at)
        && string_at(metadata, "/actor/actorId") == Some(completed.actor_id.as_str())
        && string_at(metadata, "/actor/tenantId") == Some(completed.tenant_id.as_str())
        && string_at(metadata, "/actor/spaceId") == Some(completed.space_id.as_str())
        && string_at(metadata, "/workspace/workspaceKey") == Some(completed.workspace_key.as_str())
        && string_at(metadata, "/workspace/bindingId")
            == Some(completed.workspace_binding_id.as_str())
        && string_at(metadata, "/workspace/scope") == Some(completed.workspace_scope.as_str())
        && string_at(metadata, "/workspace/scopeId") == Some(completed.workspace_scope_id.as_str())
        && string_at(metadata, "/execution/type") == Some("conversation")
        && string_at(metadata, "/execution/threadId") == Some(completed.thread_id.as_str())
        && string_at(metadata, "/execution/turnId") == Some(completed.turn_id.as_str())
        && string_at(metadata, "/trace/traceId") == Some(completed.trace_id.as_str())
        && string_at(metadata, "/trace/spanId") == Some(completed.span_id.as_str())
        && optional_string_at(metadata, "/trace/parentSpanId")
            == Some(completed.parent_span_id.as_deref())
        && string_at(metadata, "/cost/type") == Some("none")
        && string_at(metadata, "/resource/type") == Some("resource")
        && string_at(metadata, "/resource/resource/provider/providerId")
            == Some(completed.provider_id.as_str())
        && string_at(metadata, "/resource/resource/provider/protocolVersion")
            == Some(completed.protocol_version.as_str())
        && string_at(metadata, "/resource/resource/kind") == Some(completed.resource_kind.as_str())
        && string_at(metadata, "/resource/resource/resourceId")
            == Some(completed.resource_id.as_str())
        && string_at(metadata, "/resource/resource/revision")
            == Some(completed.resource_revision.as_str())
        && string_at(metadata, "/payload/type") == Some("none")
}

fn outcome_matches(completed: &DynamicToolExecutionRecord, metadata: &Value) -> bool {
    match completed.terminal {
        DynamicToolExecutionTerminalRecord::Claimed => false,
        DynamicToolExecutionTerminalRecord::Succeeded(_) => {
            string_at(metadata, "/outcome/type") == Some("succeeded")
        }
        DynamicToolExecutionTerminalRecord::Failed(code) => {
            string_at(metadata, "/outcome/type") == Some("failed")
                && string_at(metadata, "/outcome/errorCode") == Some(failure_error_code(code))
        }
        DynamicToolExecutionTerminalRecord::Unknown(code) => {
            string_at(metadata, "/outcome/type") == Some("unknown")
                && string_at(metadata, "/outcome/errorCode") == Some(unknown_error_code(code))
        }
    }
}

fn approval_matches(completed: &DynamicToolExecutionRecord, metadata: &Value) -> bool {
    match completed.approval_id.as_deref() {
        Some(approval_id) => {
            string_at(metadata, "/approval/type") == Some("decision")
                && string_at(metadata, "/approval/approvalId") == Some(approval_id)
                && string_at(metadata, "/approval/accessDecisionId")
                    == Some(completed.access_decision_id.as_str())
                && string_at(metadata, "/approval/actionDigest")
                    == Some(completed.action_digest.as_str())
        }
        None => string_at(metadata, "/approval/type") == Some("none"),
    }
}

fn artifacts_match(completed: &DynamicToolExecutionRecord, metadata: &Value) -> bool {
    let Some(artifacts) = metadata.pointer("/artifacts").and_then(Value::as_array) else {
        return false;
    };
    match &completed.terminal {
        DynamicToolExecutionTerminalRecord::Succeeded(
            DynamicToolExecutionResultRecord::Artifact {
                artifact_id,
                revision,
            },
        ) => {
            artifacts.len() == 1
                && artifacts[0].get("artifactId").and_then(Value::as_str)
                    == Some(artifact_id.as_str())
                && artifacts[0].get("revision").and_then(Value::as_u64) == Some(*revision)
        }
        DynamicToolExecutionTerminalRecord::Claimed
        | DynamicToolExecutionTerminalRecord::Succeeded(
            DynamicToolExecutionResultRecord::Inline { .. },
        )
        | DynamicToolExecutionTerminalRecord::Failed(_)
        | DynamicToolExecutionTerminalRecord::Unknown(_) => artifacts.is_empty(),
    }
}

async fn artifact_exists(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    artifact_id: &str,
    revision: u64,
) -> anyhow::Result<bool> {
    let revision = i64::try_from(revision)
        .map_err(|_| anyhow::anyhow!("Dynamic Tool artifact revision is out of range"))?;
    Ok(sqlx::query_scalar::<_, i64>(
        "SELECT 1 FROM artifact_manifests WHERE artifact_id = ? AND revision = ?",
    )
    .bind(artifact_id)
    .bind(revision)
    .fetch_optional(&mut **tx)
    .await?
    .is_some())
}

const fn failure_error_code(code: DynamicToolExecutionFailureCode) -> &'static str {
    match code {
        DynamicToolExecutionFailureCode::Rejected => "dynamicTool.rejected",
        DynamicToolExecutionFailureCode::ExecutionFailed => "dynamicTool.executionFailed",
    }
}

const fn unknown_error_code(code: DynamicToolExecutionUnknownCode) -> &'static str {
    match code {
        DynamicToolExecutionUnknownCode::Timeout => "dynamicTool.timeout",
        DynamicToolExecutionUnknownCode::AdapterUnavailable => "dynamicTool.adapterUnavailable",
        DynamicToolExecutionUnknownCode::InvalidResponse => "dynamicTool.invalidResponse",
    }
}

fn string_at<'a>(metadata: &'a Value, pointer: &str) -> Option<&'a str> {
    metadata.pointer(pointer).and_then(Value::as_str)
}

fn optional_string_at<'a>(metadata: &'a Value, pointer: &str) -> Option<Option<&'a str>> {
    let value = metadata.pointer(pointer)?;
    if value.is_null() {
        Some(None)
    } else {
        value.as_str().map(Some)
    }
}

fn integer_at(metadata: &Value, pointer: &str) -> Option<i64> {
    metadata.pointer(pointer).and_then(Value::as_i64)
}
