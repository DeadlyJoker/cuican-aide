use super::StateRuntime;
use super::artifacts::insert_audit_event;
use super::artifacts::storage_mapping::audit_event_hash;
use super::dynamic_tool_execution_audit::DynamicToolAuditIdentity;
use super::dynamic_tool_execution_audit::dynamic_tool_audit_identity;
use super::dynamic_tool_execution_audit::dynamic_tool_audit_matches_completion;
use super::dynamic_tool_execution_storage::binding_matches_claim;
use super::dynamic_tool_execution_storage::connection_matches_claim;
use super::dynamic_tool_execution_storage::credential_matches_claim;
use super::dynamic_tool_execution_storage::execution_by_call_id;
use super::dynamic_tool_execution_storage::execution_from_row;
use super::dynamic_tool_execution_storage::execution_query;
use super::dynamic_tool_execution_storage::insert_execution;
use super::dynamic_tool_execution_storage::provider_identity_matches_claim;
use super::dynamic_tool_execution_storage::update_execution_completion;
use crate::DynamicToolExecutionClaimOutcome;
use crate::DynamicToolExecutionCompletionOutcome;
use crate::DynamicToolExecutionRecord;
use crate::DynamicToolExecutionRecoveryQuery;
use crate::DynamicToolExecutionTerminalRecord;
use crate::PlatformAuditEventRecord;
use crate::dynamic_tool_execution_validation::validate_dynamic_tool_execution_call_id;

const MAX_DYNAMIC_TOOL_EXECUTION_RECORDS: i64 = 65_536;

impl StateRuntime {
    /// Atomically claims one exact Dynamic Tool call after revalidating its frozen authority.
    pub async fn claim_dynamic_tool_execution_record(
        &self,
        proposed: &DynamicToolExecutionRecord,
    ) -> anyhow::Result<DynamicToolExecutionClaimOutcome> {
        proposed.validate()?;
        if proposed.terminal != DynamicToolExecutionTerminalRecord::Claimed {
            return Ok(DynamicToolExecutionClaimOutcome::Conflict);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        if let Some(existing) = execution_by_call_id(&mut tx, &proposed.call_id).await? {
            tx.rollback().await?;
            return Ok(if existing.same_execution(proposed) {
                DynamicToolExecutionClaimOutcome::ExistingSame(existing)
            } else {
                DynamicToolExecutionClaimOutcome::Conflict
            });
        }
        if !binding_matches_claim(&mut tx, proposed).await?
            || !connection_matches_claim(&mut tx, proposed).await?
            || !credential_matches_claim(&mut tx, proposed).await?
            || !provider_identity_matches_claim(&mut tx, proposed).await?
        {
            tx.rollback().await?;
            return Ok(DynamicToolExecutionClaimOutcome::AuthorityMismatch);
        }
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM dynamic_tool_execution_journal")
            .fetch_one(&mut *tx)
            .await?;
        if count >= MAX_DYNAMIC_TOOL_EXECUTION_RECORDS {
            tx.rollback().await?;
            return Ok(DynamicToolExecutionClaimOutcome::CapacityExceeded);
        }
        insert_execution(&mut tx, proposed).await?;
        tx.commit().await?;
        Ok(DynamicToolExecutionClaimOutcome::Claimed(proposed.clone()))
    }

    /// Reads one Dynamic Tool execution after revalidating the persisted hash-bound record.
    pub async fn get_dynamic_tool_execution_record(
        &self,
        call_id: &str,
    ) -> anyhow::Result<Option<DynamicToolExecutionRecord>> {
        validate_dynamic_tool_execution_call_id(call_id)?;
        execution_query()
            .bind(call_id)
            .fetch_optional(self.pool.as_ref())
            .await?
            .map(execution_from_row)
            .transpose()
    }

    /// Atomically transitions one claim to a terminal state and appends its ExternalAction Audit.
    pub async fn complete_dynamic_tool_execution_record(
        &self,
        completed: &DynamicToolExecutionRecord,
        audit_event: &PlatformAuditEventRecord,
    ) -> anyhow::Result<DynamicToolExecutionCompletionOutcome> {
        completed.validate()?;
        audit_event.validate()?;
        if completed.terminal == DynamicToolExecutionTerminalRecord::Claimed {
            return Ok(DynamicToolExecutionCompletionOutcome::Conflict);
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let Some(current) = execution_by_call_id(&mut tx, &completed.call_id).await? else {
            tx.rollback().await?;
            return Ok(DynamicToolExecutionCompletionOutcome::NotFound);
        };
        if current.terminal != DynamicToolExecutionTerminalRecord::Claimed {
            let audit_matches = current == *completed
                && dynamic_tool_audit_matches_completion(&mut tx, completed, audit_event).await?;
            let identity = dynamic_tool_audit_identity(&mut tx, audit_event).await?;
            tx.rollback().await?;
            return Ok(
                if audit_matches && matches!(identity, DynamicToolAuditIdentity::ExistingSame) {
                    DynamicToolExecutionCompletionOutcome::ExistingSame(current)
                } else {
                    DynamicToolExecutionCompletionOutcome::Conflict
                },
            );
        }
        if !current.same_claim(completed) {
            tx.rollback().await?;
            return Ok(DynamicToolExecutionCompletionOutcome::Conflict);
        }
        if !dynamic_tool_audit_matches_completion(&mut tx, completed, audit_event).await?
            || !matches!(
                dynamic_tool_audit_identity(&mut tx, audit_event).await?,
                DynamicToolAuditIdentity::Absent
            )
        {
            tx.rollback().await?;
            return Ok(DynamicToolExecutionCompletionOutcome::AuditConflict);
        }
        insert_audit_event(&mut tx, audit_event, &audit_event_hash(audit_event)).await?;
        if !update_execution_completion(&mut tx, &current, completed).await? {
            tx.rollback().await?;
            return Ok(DynamicToolExecutionCompletionOutcome::Conflict);
        }
        tx.commit().await?;
        Ok(DynamicToolExecutionCompletionOutcome::Completed(
            completed.clone(),
        ))
    }

    /// Lists a bounded page of stale claims for post-restart reconciliation without replaying them.
    pub async fn list_recoverable_dynamic_tool_execution_records(
        &self,
        query: &DynamicToolExecutionRecoveryQuery,
    ) -> anyhow::Result<Vec<DynamicToolExecutionRecord>> {
        query.validate()?;
        let rows = if let Some(after_call_id) = query.after_call_id.as_deref() {
            recoverable_query_with_cursor()
                .bind(query.stale_before_or_at)
                .bind(after_call_id)
                .bind(i64::from(query.limit))
                .fetch_all(self.pool.as_ref())
                .await?
        } else {
            recoverable_query()
                .bind(query.stale_before_or_at)
                .bind(i64::from(query.limit))
                .fetch_all(self.pool.as_ref())
                .await?
        };
        rows.into_iter().map(execution_from_row).collect()
    }
}

fn recoverable_query() -> sqlx::query::Query<'static, sqlx::Sqlite, sqlx::sqlite::SqliteArguments> {
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
WHERE status = 'claimed' AND updated_at <= ?
ORDER BY call_id ASC
LIMIT ?
        "#,
    )
}

fn recoverable_query_with_cursor()
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
WHERE status = 'claimed' AND updated_at <= ? AND call_id > ?
ORDER BY call_id ASC
LIMIT ?
        "#,
    )
}
