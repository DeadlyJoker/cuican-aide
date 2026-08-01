use sqlx::Row;

use crate::DynamicToolExecutionFailureCode;
use crate::DynamicToolExecutionOperation;
use crate::DynamicToolExecutionRecord;
use crate::DynamicToolExecutionResultRecord;
use crate::DynamicToolExecutionTerminalRecord;
use crate::DynamicToolExecutionUnknownCode;
use crate::ProviderAccessGrantStatus;
use crate::ProviderIdentityBindingStatus;
use crate::ProviderResourceBindingStatus;
use crate::ProviderResourceExecutionLocation;
use crate::ProviderResourceKind;
use crate::ProviderResourceWorkspaceScope;

use super::provider_access_grant::grant_from_row;
use super::provider_access_grant::grant_query;
use super::provider_connection::connection_from_row;
use super::provider_connection::connection_query;
use super::provider_identity::binding_from_row as identity_binding_from_row;
use super::provider_identity::binding_query as identity_binding_query;
use super::provider_resource_binding::binding_from_row;
use super::provider_resource_binding::binding_query;

pub(super) fn execution_query()
-> sqlx::query::Query<'static, sqlx::Sqlite, sqlx::sqlite::SqliteArguments> {
    sqlx::query(
        r#"
SELECT call_id, action_digest, access_decision_id, approval_id,
       actor_id, tenant_id, space_id, session_id, trace_id, span_id, parent_span_id,
       thread_id, turn_id, workspace_key, workspace_binding_id, workspace_scope,
       workspace_scope_id, binding_id, binding_revision, connection_id, provider_id,
       protocol_version, resource_kind, resource_id, resource_revision,
       execution_location, credential_id, credential_revision,
       provider_identity_binding_id, provider_identity_binding_revision,
       provider_subject, provider_tenant_id, provider_space_id, operation,
       status, terminal_code, result_kind, result_item_count, result_byte_len,
       result_digest, artifact_id, artifact_revision, audit_event_id,
       claim_hash, record_hash, created_at, updated_at
FROM dynamic_tool_execution_journal
WHERE call_id = ?
        "#,
    )
}

pub(super) async fn execution_by_call_id(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    call_id: &str,
) -> anyhow::Result<Option<DynamicToolExecutionRecord>> {
    execution_query()
        .bind(call_id)
        .fetch_optional(&mut **tx)
        .await?
        .map(execution_from_row)
        .transpose()
}

pub(super) fn execution_from_row(
    row: sqlx::sqlite::SqliteRow,
) -> anyhow::Result<DynamicToolExecutionRecord> {
    let status = row.try_get::<String, _>("status")?;
    let terminal_code = row.try_get::<Option<String>, _>("terminal_code")?;
    let result_kind = row.try_get::<String, _>("result_kind")?;
    let terminal = terminal_from_storage(&row, &status, terminal_code.as_deref(), &result_kind)?;
    let record = DynamicToolExecutionRecord {
        call_id: row.try_get("call_id")?,
        action_digest: row.try_get("action_digest")?,
        access_decision_id: row.try_get("access_decision_id")?,
        approval_id: row.try_get("approval_id")?,
        actor_id: row.try_get("actor_id")?,
        tenant_id: row.try_get("tenant_id")?,
        space_id: row.try_get("space_id")?,
        session_id: row.try_get("session_id")?,
        trace_id: row.try_get("trace_id")?,
        span_id: row.try_get("span_id")?,
        parent_span_id: row.try_get("parent_span_id")?,
        thread_id: row.try_get("thread_id")?,
        turn_id: row.try_get("turn_id")?,
        workspace_key: row.try_get("workspace_key")?,
        workspace_binding_id: row.try_get("workspace_binding_id")?,
        workspace_scope: ProviderResourceWorkspaceScope::from_str(
            row.try_get::<&str, _>("workspace_scope")?,
        )?,
        workspace_scope_id: row.try_get("workspace_scope_id")?,
        binding_id: row.try_get("binding_id")?,
        binding_revision: storage_u64(row.try_get("binding_revision")?, "bindingRevision")?,
        connection_id: row.try_get("connection_id")?,
        provider_id: row.try_get("provider_id")?,
        protocol_version: row.try_get("protocol_version")?,
        resource_kind: ProviderResourceKind::from_str(row.try_get("resource_kind")?)?,
        resource_id: row.try_get("resource_id")?,
        resource_revision: row.try_get("resource_revision")?,
        execution_location: ProviderResourceExecutionLocation::from_str(
            row.try_get("execution_location")?,
        )?,
        credential_id: row.try_get("credential_id")?,
        credential_revision: row
            .try_get::<Option<i64>, _>("credential_revision")?
            .map(|value| storage_u64(value, "credentialRevision"))
            .transpose()?,
        provider_identity_binding_id: row.try_get("provider_identity_binding_id")?,
        provider_identity_binding_revision: row
            .try_get::<Option<i64>, _>("provider_identity_binding_revision")?
            .map(|value| storage_u64(value, "providerIdentityBindingRevision"))
            .transpose()?,
        provider_subject: row.try_get("provider_subject")?,
        provider_tenant_id: row.try_get("provider_tenant_id")?,
        provider_space_id: row.try_get("provider_space_id")?,
        operation: DynamicToolExecutionOperation::from_str(row.try_get("operation")?)?,
        terminal,
        audit_event_id: row.try_get("audit_event_id")?,
        claim_hash: row.try_get("claim_hash")?,
        record_hash: row.try_get("record_hash")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    };
    record.validate()?;
    Ok(record)
}

pub(super) async fn insert_execution(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &DynamicToolExecutionRecord,
) -> anyhow::Result<()> {
    let inserted = sqlx::query(
        r#"
INSERT INTO dynamic_tool_execution_journal (
    call_id, action_digest, access_decision_id, approval_id,
    actor_id, tenant_id, space_id, session_id, trace_id, span_id, parent_span_id,
    thread_id, turn_id, workspace_key, workspace_binding_id, workspace_scope,
    workspace_scope_id, binding_id, binding_revision, connection_id, provider_id,
    protocol_version, resource_kind, resource_id, resource_revision,
    execution_location, credential_id, credential_revision,
    provider_identity_binding_id, provider_identity_binding_revision,
    provider_subject, provider_tenant_id, provider_space_id, operation,
    status, result_kind, claim_hash, record_hash, created_at, updated_at
) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', 'none', ?, ?, ?, ?
)
        "#,
    )
    .bind(&record.call_id)
    .bind(&record.action_digest)
    .bind(&record.access_decision_id)
    .bind(&record.approval_id)
    .bind(&record.actor_id)
    .bind(&record.tenant_id)
    .bind(&record.space_id)
    .bind(&record.session_id)
    .bind(&record.trace_id)
    .bind(&record.span_id)
    .bind(&record.parent_span_id)
    .bind(&record.thread_id)
    .bind(&record.turn_id)
    .bind(&record.workspace_key)
    .bind(&record.workspace_binding_id)
    .bind(record.workspace_scope.as_str())
    .bind(&record.workspace_scope_id)
    .bind(&record.binding_id)
    .bind(storage_i64(record.binding_revision, "bindingRevision")?)
    .bind(&record.connection_id)
    .bind(&record.provider_id)
    .bind(&record.protocol_version)
    .bind(record.resource_kind.as_str())
    .bind(&record.resource_id)
    .bind(&record.resource_revision)
    .bind(record.execution_location.as_str())
    .bind(&record.credential_id)
    .bind(
        record
            .credential_revision
            .map(|value| storage_i64(value, "credentialRevision"))
            .transpose()?,
    )
    .bind(&record.provider_identity_binding_id)
    .bind(
        record
            .provider_identity_binding_revision
            .map(|value| storage_i64(value, "providerIdentityBindingRevision"))
            .transpose()?,
    )
    .bind(&record.provider_subject)
    .bind(&record.provider_tenant_id)
    .bind(&record.provider_space_id)
    .bind(record.operation.as_str())
    .bind(&record.claim_hash)
    .bind(&record.record_hash)
    .bind(record.created_at)
    .bind(record.updated_at)
    .execute(&mut **tx)
    .await?;
    if inserted.rows_affected() != 1 {
        anyhow::bail!("Dynamic Tool execution claim insert failed");
    }
    Ok(())
}

pub(super) async fn update_execution_completion(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    current: &DynamicToolExecutionRecord,
    completed: &DynamicToolExecutionRecord,
) -> anyhow::Result<bool> {
    let fields = CompletionStorageFields::from_record(completed)?;
    let updated = sqlx::query(
        r#"
UPDATE dynamic_tool_execution_journal
SET status = ?, terminal_code = ?, result_kind = ?, result_item_count = ?,
    result_byte_len = ?, result_digest = ?, artifact_id = ?, artifact_revision = ?,
    audit_event_id = ?, record_hash = ?, updated_at = ?
WHERE call_id = ? AND status = 'claimed' AND claim_hash = ? AND record_hash = ?
        "#,
    )
    .bind(fields.status)
    .bind(fields.terminal_code)
    .bind(fields.result_kind)
    .bind(fields.result_item_count)
    .bind(fields.result_byte_len)
    .bind(fields.result_digest)
    .bind(fields.artifact_id)
    .bind(fields.artifact_revision)
    .bind(&completed.audit_event_id)
    .bind(&completed.record_hash)
    .bind(completed.updated_at)
    .bind(&completed.call_id)
    .bind(&current.claim_hash)
    .bind(&current.record_hash)
    .execute(&mut **tx)
    .await?;
    Ok(updated.rows_affected() == 1)
}

pub(super) async fn binding_matches_claim(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &DynamicToolExecutionRecord,
) -> anyhow::Result<bool> {
    let row = binding_query()
        .bind(&record.binding_id)
        .fetch_optional(&mut **tx)
        .await?;
    let Some(row) = row else {
        return Ok(false);
    };
    let binding = binding_from_row(row)?;
    Ok(binding.local_actor_id == record.actor_id
        && binding.local_tenant_id == record.tenant_id
        && binding.local_space_id == record.space_id
        && binding.connection_id == record.connection_id
        && binding.workspace_key == record.workspace_key
        && binding.workspace_scope == record.workspace_scope
        && binding.workspace_scope_id == record.workspace_scope_id
        && binding.provider_id == record.provider_id
        && binding.protocol_version == record.protocol_version
        && binding.resource_kind == record.resource_kind
        && binding.resource_id == record.resource_id
        && binding.resource_revision == record.resource_revision
        && binding.execution_location == record.execution_location
        && binding.status == ProviderResourceBindingStatus::Active
        && binding.revision == record.binding_revision)
}

pub(super) async fn connection_matches_claim(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &DynamicToolExecutionRecord,
) -> anyhow::Result<bool> {
    let row = connection_query()
        .bind(&record.connection_id)
        .fetch_optional(&mut **tx)
        .await?;
    let Some(row) = row else {
        return Ok(false);
    };
    let connection = connection_from_row(row)?;
    let credential_matches = match record.execution_location {
        ProviderResourceExecutionLocation::LocalNode => false,
        ProviderResourceExecutionLocation::Provider => {
            record.credential_id.as_deref() == Some(connection.credential_id.as_str())
                && record.credential_revision == Some(connection.credential_revision)
        }
    };
    Ok(connection.local_actor_id == record.actor_id
        && connection.local_tenant_id == record.tenant_id
        && connection.local_space_id == record.space_id
        && connection.provider_id == record.provider_id
        && connection.protocol_version == record.protocol_version
        && credential_matches)
}

pub(super) async fn credential_matches_claim(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &DynamicToolExecutionRecord,
) -> anyhow::Result<bool> {
    let (Some(credential_id), Some(credential_revision)) =
        (&record.credential_id, record.credential_revision)
    else {
        return Ok(false);
    };
    let row = grant_query()
        .bind(credential_id)
        .fetch_optional(&mut **tx)
        .await?;
    let Some(row) = row else {
        return Ok(false);
    };
    let grant = grant_from_row(row)?;
    Ok(grant.local_actor_id == record.actor_id
        && grant.local_tenant_id == record.tenant_id
        && grant.local_space_id == record.space_id
        && grant.provider_id == record.provider_id
        && grant.status == ProviderAccessGrantStatus::Active
        && grant.expires_at > record.created_at
        && grant.revision == credential_revision)
}

pub(super) async fn provider_identity_matches_claim(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    record: &DynamicToolExecutionRecord,
) -> anyhow::Result<bool> {
    let (
        Some(binding_id),
        Some(binding_revision),
        Some(provider_subject),
        Some(provider_tenant_id),
        Some(provider_space_id),
    ) = (
        &record.provider_identity_binding_id,
        record.provider_identity_binding_revision,
        &record.provider_subject,
        &record.provider_tenant_id,
        &record.provider_space_id,
    )
    else {
        return Ok(false);
    };
    let row = identity_binding_query()
        .bind(binding_id)
        .fetch_optional(&mut **tx)
        .await?;
    let Some(row) = row else {
        return Ok(false);
    };
    let identity = identity_binding_from_row(row)?;
    Ok(
        record.execution_location == ProviderResourceExecutionLocation::Provider
            && identity.local_actor_id == record.actor_id
            && identity.local_tenant_id == record.tenant_id
            && identity.local_space_id == record.space_id
            && identity.provider_id == record.provider_id
            && identity.provider_subject == *provider_subject
            && identity.provider_tenant_id == *provider_tenant_id
            && identity.provider_space_id == *provider_space_id
            && identity.status == ProviderIdentityBindingStatus::Active
            && identity.source_fresh_until > record.created_at
            && identity.revision == binding_revision,
    )
}

struct CompletionStorageFields<'a> {
    status: &'static str,
    terminal_code: Option<&'static str>,
    result_kind: &'static str,
    result_item_count: Option<i64>,
    result_byte_len: Option<i64>,
    result_digest: Option<&'a str>,
    artifact_id: Option<&'a str>,
    artifact_revision: Option<i64>,
}

impl<'a> CompletionStorageFields<'a> {
    fn from_record(record: &'a DynamicToolExecutionRecord) -> anyhow::Result<Self> {
        let mut fields = Self {
            status: "claimed",
            terminal_code: None,
            result_kind: "none",
            result_item_count: None,
            result_byte_len: None,
            result_digest: None,
            artifact_id: None,
            artifact_revision: None,
        };
        match &record.terminal {
            DynamicToolExecutionTerminalRecord::Claimed => {
                anyhow::bail!("Dynamic Tool completion cannot remain claimed");
            }
            DynamicToolExecutionTerminalRecord::Succeeded(result) => {
                fields.status = "succeeded";
                match result {
                    DynamicToolExecutionResultRecord::Inline {
                        item_count,
                        byte_len,
                        sha256,
                    } => {
                        fields.result_kind = "inline";
                        fields.result_item_count = Some(i64::from(*item_count));
                        fields.result_byte_len = Some(i64::from(*byte_len));
                        fields.result_digest = Some(sha256);
                    }
                    DynamicToolExecutionResultRecord::Artifact {
                        artifact_id,
                        revision,
                    } => {
                        fields.result_kind = "artifact";
                        fields.artifact_id = Some(artifact_id);
                        fields.artifact_revision =
                            Some(storage_i64(*revision, "artifactRevision")?);
                    }
                }
            }
            DynamicToolExecutionTerminalRecord::Failed(code) => {
                fields.status = "failed";
                fields.terminal_code = Some(code.as_str());
            }
            DynamicToolExecutionTerminalRecord::Unknown(code) => {
                fields.status = "unknown";
                fields.terminal_code = Some(code.as_str());
            }
        }
        Ok(fields)
    }
}

fn terminal_from_storage(
    row: &sqlx::sqlite::SqliteRow,
    status: &str,
    terminal_code: Option<&str>,
    result_kind: &str,
) -> anyhow::Result<DynamicToolExecutionTerminalRecord> {
    match (status, terminal_code, result_kind) {
        ("claimed", None, "none") => Ok(DynamicToolExecutionTerminalRecord::Claimed),
        ("succeeded", None, "inline") => Ok(DynamicToolExecutionTerminalRecord::Succeeded(
            DynamicToolExecutionResultRecord::Inline {
                item_count: storage_u16(row.try_get("result_item_count")?, "resultItemCount")?,
                byte_len: storage_u32(row.try_get("result_byte_len")?, "resultByteLen")?,
                sha256: row.try_get("result_digest")?,
            },
        )),
        ("succeeded", None, "artifact") => Ok(DynamicToolExecutionTerminalRecord::Succeeded(
            DynamicToolExecutionResultRecord::Artifact {
                artifact_id: row.try_get("artifact_id")?,
                revision: storage_u64(row.try_get("artifact_revision")?, "artifactRevision")?,
            },
        )),
        ("failed", Some(code), "none") => Ok(DynamicToolExecutionTerminalRecord::Failed(
            DynamicToolExecutionFailureCode::from_str(code)?,
        )),
        ("unknown", Some(code), "none") => Ok(DynamicToolExecutionTerminalRecord::Unknown(
            DynamicToolExecutionUnknownCode::from_str(code)?,
        )),
        _ => anyhow::bail!("invalid stored Dynamic Tool execution terminal"),
    }
}

pub(super) fn storage_i64(value: u64, field: &'static str) -> anyhow::Result<i64> {
    i64::try_from(value)
        .map_err(|_| anyhow::anyhow!("Dynamic Tool storage field {field} is out of range"))
}

fn storage_u64(value: i64, field: &'static str) -> anyhow::Result<u64> {
    u64::try_from(value)
        .map_err(|_| anyhow::anyhow!("Dynamic Tool storage field {field} is out of range"))
}

fn storage_u32(value: i64, field: &'static str) -> anyhow::Result<u32> {
    u32::try_from(value)
        .map_err(|_| anyhow::anyhow!("Dynamic Tool storage field {field} is out of range"))
}

fn storage_u16(value: i64, field: &'static str) -> anyhow::Result<u16> {
    u16::try_from(value)
        .map_err(|_| anyhow::anyhow!("Dynamic Tool storage field {field} is out of range"))
}
