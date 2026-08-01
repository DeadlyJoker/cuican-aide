use pretty_assertions::assert_eq;

use super::StateRuntime;
use crate::DurableWorkspaceRootResolveOutcome;
use crate::DynamicToolExecutionClaimInput;
use crate::DynamicToolExecutionClaimOutcome;
use crate::DynamicToolExecutionCompletionOutcome;
use crate::DynamicToolExecutionCompletionRecord;
use crate::DynamicToolExecutionOperation;
use crate::DynamicToolExecutionRecord;
use crate::DynamicToolExecutionRecoveryQuery;
use crate::DynamicToolExecutionResultRecord;
use crate::DynamicToolExecutionTerminalRecord;
use crate::DynamicToolExecutionUnknownCode;
use crate::PlatformAuditEventRecord;
use crate::ProviderAccessGrantResolveOutcome;
use crate::ProviderConnectionResolveOutcome;
use crate::ProviderIdentityBindingCreateOutcome;
use crate::ProviderResourceBindingMode;
use crate::ProviderResourceBindingResolveOutcome;
use crate::ProviderResourceExecutionLocation;
use crate::ProviderResourceKind;
use crate::ProviderResourceWorkspaceScope;
use crate::durable_workspace_records_tests::root_record;
use crate::provider_access_grant_records_tests::access_grant_record;
use crate::provider_connection_records_tests::connection_record;
use crate::provider_identity_records_tests::binding as identity_binding_record;
use crate::provider_resource_binding_records_tests::binding_record;
use crate::runtime::test_support::unique_temp_dir;

const PRINCIPAL: &str =
    "principal:6f7900eaed3218b4c15249cad129ed96bf1bde4d0524fa4b6fad1ba325e8ef3f";
const GRANT_ID: &str = "provider-grant:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c301";
const BINDING_ID: &str = "resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c401";
const IDENTITY_BINDING_ID: &str = "identity-binding-dynamic-tool-1";

#[tokio::test]
async fn dynamic_tool_claim_completion_is_atomic_idempotent_and_restart_durable() {
    let codex_home = unique_temp_dir();
    let runtime = initialized_with_authority(&codex_home).await;
    let claim = claim("call-1", 110);

    assert_eq!(
        runtime
            .claim_dynamic_tool_execution_record(&claim)
            .await
            .expect("claim Dynamic Tool"),
        DynamicToolExecutionClaimOutcome::Claimed(claim.clone())
    );
    assert_eq!(
        runtime
            .claim_dynamic_tool_execution_record(&claim)
            .await
            .expect("replay claim"),
        DynamicToolExecutionClaimOutcome::ExistingSame(claim.clone())
    );

    let completed = complete_inline(&claim, "event-call-1", 120);
    let audit = audit_event(&completed, "audit-call-1");
    assert_eq!(
        runtime
            .complete_dynamic_tool_execution_record(&completed, &audit)
            .await
            .expect("complete Dynamic Tool"),
        DynamicToolExecutionCompletionOutcome::Completed(completed.clone())
    );
    assert_eq!(
        runtime
            .complete_dynamic_tool_execution_record(&completed, &audit)
            .await
            .expect("replay completion"),
        DynamicToolExecutionCompletionOutcome::ExistingSame(completed.clone())
    );
    assert_eq!(
        runtime
            .get_platform_audit_event("event-call-1")
            .await
            .expect("read Audit Event"),
        Some(audit)
    );
    runtime.close().await;

    let reopened = initialized(&codex_home).await;
    assert_eq!(
        reopened
            .get_dynamic_tool_execution_record("call-1")
            .await
            .expect("read reopened execution"),
        Some(completed)
    );
    reopened.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn dynamic_tool_claim_revalidates_authority_and_detects_call_conflicts() {
    let codex_home = unique_temp_dir();
    let runtime = initialized_with_authority(&codex_home).await;

    let mut binding_drift = claim("call-binding-drift", 110);
    binding_drift.resource_revision = "resource-version:8".to_string();
    binding_drift.claim_hash = binding_drift.canonical_claim_hash();
    binding_drift.record_hash = binding_drift.canonical_hash();
    assert_eq!(
        runtime
            .claim_dynamic_tool_execution_record(&binding_drift)
            .await
            .expect("binding drift outcome"),
        DynamicToolExecutionClaimOutcome::AuthorityMismatch
    );

    let mut credential_drift = claim("call-credential-drift", 110);
    credential_drift.credential_revision = Some(2);
    credential_drift.claim_hash = credential_drift.canonical_claim_hash();
    credential_drift.record_hash = credential_drift.canonical_hash();
    assert_eq!(
        runtime
            .claim_dynamic_tool_execution_record(&credential_drift)
            .await
            .expect("credential drift outcome"),
        DynamicToolExecutionClaimOutcome::AuthorityMismatch
    );

    let mut identity_drift = claim("call-identity-drift", 110);
    identity_drift.provider_subject = Some("user:43".to_string());
    identity_drift.claim_hash = identity_drift.canonical_claim_hash();
    identity_drift.record_hash = identity_drift.canonical_hash();
    assert_eq!(
        runtime
            .claim_dynamic_tool_execution_record(&identity_drift)
            .await
            .expect("identity drift outcome"),
        DynamicToolExecutionClaimOutcome::AuthorityMismatch
    );

    let original_claim = claim("call-conflict", 110);
    runtime
        .claim_dynamic_tool_execution_record(&original_claim)
        .await
        .expect("create claim");
    let mut reevaluated = original_claim.clone();
    reevaluated.access_decision_id = "decision-retry".to_string();
    reevaluated.claim_hash = reevaluated.canonical_claim_hash();
    reevaluated.record_hash = reevaluated.canonical_hash();
    assert_eq!(
        runtime
            .claim_dynamic_tool_execution_record(&reevaluated)
            .await
            .expect("same execution with a new decision"),
        DynamicToolExecutionClaimOutcome::ExistingSame(original_claim.clone())
    );
    let mut conflict = original_claim.clone();
    conflict.action_digest =
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string();
    conflict.claim_hash = conflict.canonical_claim_hash();
    conflict.record_hash = conflict.canonical_hash();
    assert_eq!(
        runtime
            .claim_dynamic_tool_execution_record(&conflict)
            .await
            .expect("conflicting claim"),
        DynamicToolExecutionClaimOutcome::Conflict
    );

    sqlx::query("UPDATE provider_resource_bindings SET resource_id = ? WHERE binding_id = ?")
        .bind("resource-tampered")
        .bind(BINDING_ID)
        .execute(runtime.pool.as_ref())
        .await
        .expect("tamper authority record");
    let error = runtime
        .claim_dynamic_tool_execution_record(&claim("call-tampered-authority", 111))
        .await
        .expect_err("tampered authority must fail closed");
    assert!(error.to_string().contains("DigestMismatch"));

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn dynamic_tool_completion_rolls_back_audit_mismatch_and_missing_artifact() {
    let codex_home = unique_temp_dir();
    let runtime = initialized_with_authority(&codex_home).await;
    let first = claim("call-audit-mismatch", 110);
    runtime
        .claim_dynamic_tool_execution_record(&first)
        .await
        .expect("claim first call");
    let completed = complete_inline(&first, "event-audit-mismatch", 120);
    let mut mismatched_audit = audit_event(&completed, "audit-audit-mismatch");
    replace_json_string(
        &mut mismatched_audit.metadata_json,
        "/actor/actorId",
        "different-actor",
    );
    assert_eq!(
        runtime
            .complete_dynamic_tool_execution_record(&completed, &mismatched_audit)
            .await
            .expect("mismatched Audit outcome"),
        DynamicToolExecutionCompletionOutcome::AuditConflict
    );
    assert_eq!(
        runtime
            .get_dynamic_tool_execution_record(&first.call_id)
            .await
            .expect("read rolled-back claim"),
        Some(first.clone())
    );
    assert_eq!(
        runtime
            .get_platform_audit_event("event-audit-mismatch")
            .await
            .expect("Audit must roll back"),
        None
    );
    let correct_audit = audit_event(&completed, "audit-audit-mismatch");
    assert_eq!(
        runtime
            .complete_dynamic_tool_execution_record(&completed, &correct_audit)
            .await
            .expect("complete after rejected Audit"),
        DynamicToolExecutionCompletionOutcome::Completed(completed.clone())
    );
    let mut tampered_metadata = correct_audit.metadata_json.clone();
    replace_json_string(
        &mut tampered_metadata,
        "/actor/actorId",
        "persisted-audit-tamper",
    );
    sqlx::query("UPDATE platform_audit_events SET metadata_json = ? WHERE event_id = ?")
        .bind(tampered_metadata)
        .bind(&correct_audit.event_id)
        .execute(runtime.pool.as_ref())
        .await
        .expect("tamper persisted Audit");
    assert!(
        runtime
            .get_platform_audit_event(&correct_audit.event_id)
            .await
            .expect_err("tampered Audit read must fail closed")
            .to_string()
            .contains("hash mismatch")
    );
    assert_eq!(
        runtime
            .complete_dynamic_tool_execution_record(&completed, &correct_audit)
            .await
            .expect("replay against tampered Audit"),
        DynamicToolExecutionCompletionOutcome::Conflict
    );

    let second = claim("call-missing-artifact", 111);
    runtime
        .claim_dynamic_tool_execution_record(&second)
        .await
        .expect("claim second call");
    let completed = second
        .complete(
            DynamicToolExecutionCompletionRecord::Succeeded(
                DynamicToolExecutionResultRecord::Artifact {
                    artifact_id: "artifact-missing".to_string(),
                    revision: 1,
                },
            ),
            "event-missing-artifact",
            121,
        )
        .expect("build Artifact completion");
    let audit = audit_event(&completed, "audit-missing-artifact");
    assert_eq!(
        runtime
            .complete_dynamic_tool_execution_record(&completed, &audit)
            .await
            .expect("missing Artifact outcome"),
        DynamicToolExecutionCompletionOutcome::AuditConflict
    );
    assert_eq!(
        runtime
            .get_dynamic_tool_execution_record(&second.call_id)
            .await
            .expect("read second rolled-back claim"),
        Some(second)
    );

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn dynamic_tool_concurrent_completion_has_one_terminal_winner() {
    let codex_home = unique_temp_dir();
    let runtime = initialized_with_authority(&codex_home).await;
    let claim = claim("call-race", 110);
    runtime
        .claim_dynamic_tool_execution_record(&claim)
        .await
        .expect("claim race call");
    let succeeded = complete_inline(&claim, "event-race-success", 120);
    let unknown = claim
        .complete(
            DynamicToolExecutionCompletionRecord::Unknown(DynamicToolExecutionUnknownCode::Timeout),
            "event-race-unknown",
            120,
        )
        .expect("build unknown completion");
    let success_audit = audit_event(&succeeded, "audit-race-success");
    let unknown_audit = audit_event(&unknown, "audit-race-unknown");
    let (success_outcome, unknown_outcome) = tokio::join!(
        runtime.complete_dynamic_tool_execution_record(&succeeded, &success_audit),
        runtime.complete_dynamic_tool_execution_record(&unknown, &unknown_audit)
    );
    let outcomes = [
        success_outcome.expect("success completion race"),
        unknown_outcome.expect("unknown completion race"),
    ];
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| {
                matches!(outcome, DynamicToolExecutionCompletionOutcome::Completed(_))
            })
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|outcome| matches!(outcome, DynamicToolExecutionCompletionOutcome::Conflict))
            .count(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM platform_audit_events")
            .fetch_one(runtime.pool.as_ref())
            .await
            .expect("count Audit Events"),
        1
    );

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn dynamic_tool_recovery_is_bounded_cursor_based_and_never_replays() {
    let codex_home = unique_temp_dir();
    let runtime = initialized_with_authority(&codex_home).await;
    for call_id in ["call-recovery-b", "call-recovery-a"] {
        runtime
            .claim_dynamic_tool_execution_record(&claim(call_id, 110))
            .await
            .expect("seed recoverable claim");
    }
    runtime.close().await;

    let reopened = initialized(&codex_home).await;
    let first_page = reopened
        .list_recoverable_dynamic_tool_execution_records(&DynamicToolExecutionRecoveryQuery {
            stale_before_or_at: 110,
            after_call_id: None,
            limit: 1,
        })
        .await
        .expect("first recovery page");
    assert_eq!(
        first_page
            .iter()
            .map(|record| record.call_id.as_str())
            .collect::<Vec<_>>(),
        vec!["call-recovery-a"]
    );
    let second_page = reopened
        .list_recoverable_dynamic_tool_execution_records(&DynamicToolExecutionRecoveryQuery {
            stale_before_or_at: 110,
            after_call_id: Some(first_page[0].call_id.clone()),
            limit: 1,
        })
        .await
        .expect("second recovery page");
    assert_eq!(
        second_page
            .iter()
            .map(|record| record.call_id.as_str())
            .collect::<Vec<_>>(),
        vec!["call-recovery-b"]
    );
    assert!(first_page.iter().chain(&second_page).all(|record| {
        record.terminal == DynamicToolExecutionTerminalRecord::Claimed
            && record.audit_event_id.is_none()
    }));

    reopened.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn local_dynamic_tool_claim_is_rejected_until_a_real_materialization_contract_exists() {
    let codex_home = unique_temp_dir();
    let runtime = initialized_with_authority(&codex_home).await;
    let mut local_claim = claim("call-local", 110);
    local_claim.execution_location = ProviderResourceExecutionLocation::LocalNode;
    local_claim.credential_id = None;
    local_claim.credential_revision = None;
    local_claim.provider_identity_binding_id = None;
    local_claim.provider_identity_binding_revision = None;
    local_claim.provider_subject = None;
    local_claim.provider_tenant_id = None;
    local_claim.provider_space_id = None;
    local_claim.claim_hash = local_claim.canonical_claim_hash();
    local_claim.record_hash = local_claim.canonical_hash();

    runtime
        .claim_dynamic_tool_execution_record(&local_claim)
        .await
        .expect_err("local Dynamic Tool claims must fail closed");

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

fn claim(call_id: &str, created_at: i64) -> DynamicToolExecutionRecord {
    DynamicToolExecutionRecord::claimed(DynamicToolExecutionClaimInput {
        call_id: call_id.to_string(),
        action_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            .to_string(),
        access_decision_id: "decision-1".to_string(),
        approval_id: Some("approval-1".to_string()),
        actor_id: PRINCIPAL.to_string(),
        tenant_id: "7".to_string(),
        space_id: "11".to_string(),
        session_id: "session-1".to_string(),
        trace_id: "trace-1".to_string(),
        span_id: format!("span-{call_id}"),
        parent_span_id: Some("span-parent-1".to_string()),
        thread_id: "thread-1".to_string(),
        turn_id: "turn-1".to_string(),
        workspace_key: "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c001".to_string(),
        workspace_binding_id: "workspace-binding-1".to_string(),
        workspace_scope: ProviderResourceWorkspaceScope::Office,
        workspace_scope_id: "office-1".to_string(),
        binding_id: BINDING_ID.to_string(),
        binding_revision: 1,
        connection_id: "provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101".to_string(),
        provider_id: "agent-platform".to_string(),
        protocol_version: "3.0.0".to_string(),
        resource_kind: ProviderResourceKind::McpTool,
        resource_id: "resource-9".to_string(),
        resource_revision: "resource-version:7".to_string(),
        execution_location: ProviderResourceExecutionLocation::Provider,
        credential_id: Some(GRANT_ID.to_string()),
        credential_revision: Some(1),
        provider_identity_binding_id: Some(IDENTITY_BINDING_ID.to_string()),
        provider_identity_binding_revision: Some(1),
        provider_subject: Some("user:42".to_string()),
        provider_tenant_id: Some("7".to_string()),
        provider_space_id: Some("11".to_string()),
        operation: DynamicToolExecutionOperation::Call,
        created_at,
    })
    .expect("valid Dynamic Tool claim")
}

fn complete_inline(
    claim: &DynamicToolExecutionRecord,
    event_id: &str,
    completed_at: i64,
) -> DynamicToolExecutionRecord {
    claim
        .complete(
            DynamicToolExecutionCompletionRecord::Succeeded(
                DynamicToolExecutionResultRecord::Inline {
                    item_count: 2,
                    byte_len: 120,
                    sha256:
                        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
                            .to_string(),
                },
            ),
            event_id,
            completed_at,
        )
        .expect("valid inline completion")
}

fn audit_event(
    completed: &DynamicToolExecutionRecord,
    idempotency_key: &str,
) -> PlatformAuditEventRecord {
    let event_id = completed.audit_event_id.as_deref().expect("event id");
    let outcome = match completed.terminal {
        DynamicToolExecutionTerminalRecord::Succeeded(_) => {
            serde_json::json!({"type": "succeeded"})
        }
        DynamicToolExecutionTerminalRecord::Unknown(DynamicToolExecutionUnknownCode::Timeout) => {
            serde_json::json!({"type": "unknown", "errorCode": "dynamicTool.timeout"})
        }
        _ => panic!("fixture only covers succeeded or timeout"),
    };
    let artifacts = match &completed.terminal {
        DynamicToolExecutionTerminalRecord::Succeeded(
            DynamicToolExecutionResultRecord::Artifact {
                artifact_id,
                revision,
            },
        ) => serde_json::json!([{"artifactId": artifact_id, "revision": revision}]),
        _ => serde_json::json!([]),
    };
    PlatformAuditEventRecord {
        event_id: event_id.to_string(),
        idempotency_key: idempotency_key.to_string(),
        event_type: "externalAction".to_string(),
        metadata_json: serde_json::json!({
            "schemaVersion": 1,
            "eventId": event_id,
            "idempotencyKey": idempotency_key,
            "actor": {
                "actorId": completed.actor_id,
                "tenantId": completed.tenant_id,
                "spaceId": completed.space_id
            },
            "workspace": {
                "workspaceKey": completed.workspace_key,
                "bindingId": completed.workspace_binding_id,
                "scope": completed.workspace_scope.as_str(),
                "scopeId": completed.workspace_scope_id
            },
            "execution": {
                "type": "conversation",
                "threadId": completed.thread_id,
                "turnId": completed.turn_id
            },
            "action": "externalAction",
            "outcome": outcome,
            "trace": {
                "traceId": completed.trace_id,
                "spanId": completed.span_id,
                "parentSpanId": completed.parent_span_id
            },
            "cost": {"type": "none"},
            "resource": {
                "type": "resource",
                "resource": {
                    "provider": {
                        "providerId": completed.provider_id,
                        "protocolVersion": completed.protocol_version
                    },
                    "kind": completed.resource_kind.as_str(),
                    "resourceId": completed.resource_id,
                    "revision": completed.resource_revision
                }
            },
            "approval": {
                "type": "decision",
                "approvalId": completed.approval_id,
                "accessDecisionId": completed.access_decision_id,
                "actionDigest": completed.action_digest
            },
            "artifacts": artifacts,
            "payload": {"type": "none"},
            "occurredAt": completed.updated_at
        })
        .to_string(),
        payload_id: None,
        occurred_at: completed.updated_at,
    }
}

async fn initialized_with_authority(codex_home: &std::path::Path) -> std::sync::Arc<StateRuntime> {
    let runtime = initialized(codex_home).await;
    let root = root_record(
        "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c001",
        &format!("sha256:{}", "c".repeat(64)),
    );
    assert_eq!(
        runtime
            .resolve_durable_workspace_root_record(&root)
            .await
            .expect("create durable workspace"),
        DurableWorkspaceRootResolveOutcome::Created(root)
    );

    let mut grant = access_grant_record(GRANT_ID);
    grant.expires_at = 1_000;
    grant.record_hash = grant.canonical_hash();
    assert_eq!(
        runtime
            .resolve_provider_access_grant_record(&grant)
            .await
            .expect("create Provider access grant"),
        ProviderAccessGrantResolveOutcome::Created(grant.clone())
    );

    let mut identity_binding = identity_binding_record(IDENTITY_BINDING_ID);
    identity_binding.local_actor_id = PRINCIPAL.to_string();
    identity_binding.local_tenant_id = "7".to_string();
    identity_binding.local_space_id = "11".to_string();
    identity_binding.source_fresh_until = 1_000;
    identity_binding.record_hash = identity_binding.canonical_hash();
    assert_eq!(
        runtime
            .create_provider_identity_binding_record(&identity_binding)
            .await
            .expect("create Provider identity binding"),
        ProviderIdentityBindingCreateOutcome::Created
    );

    let mut connection =
        connection_record("provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101");
    connection.local_actor_id = PRINCIPAL.to_string();
    connection.local_tenant_id = "7".to_string();
    connection.local_space_id = "11".to_string();
    connection.credential_id = GRANT_ID.to_string();
    connection.credential_revision = 1;
    connection.record_hash = connection.canonical_hash();
    assert_eq!(
        runtime
            .resolve_provider_connection_record(&connection)
            .await
            .expect("create Provider connection"),
        ProviderConnectionResolveOutcome::Created(connection)
    );

    let mut binding = binding_record(BINDING_ID);
    binding.local_actor_id = PRINCIPAL.to_string();
    binding.local_tenant_id = "7".to_string();
    binding.local_space_id = "11".to_string();
    binding.resource_kind = ProviderResourceKind::McpTool;
    binding.resource_id = "resource-9".to_string();
    binding.resource_revision = "resource-version:7".to_string();
    binding.binding_mode = ProviderResourceBindingMode::ProviderManaged;
    binding.execution_location = ProviderResourceExecutionLocation::Provider;
    binding.record_hash = binding.canonical_hash();
    assert_eq!(
        runtime
            .resolve_provider_resource_binding_record(&binding)
            .await
            .expect("create resource binding"),
        ProviderResourceBindingResolveOutcome::Created(binding)
    );
    runtime
}

async fn initialized(codex_home: &std::path::Path) -> std::sync::Arc<StateRuntime> {
    StateRuntime::init(codex_home.to_path_buf(), "test-provider".to_string())
        .await
        .expect("initialize State Runtime")
}

fn replace_json_string(json: &mut String, pointer: &str, replacement: &str) {
    let mut value: serde_json::Value = serde_json::from_str(json).expect("parse fixture JSON");
    *value
        .pointer_mut(pointer)
        .expect("fixture JSON pointer must exist") =
        serde_json::Value::String(replacement.to_string());
    *json = value.to_string();
}
