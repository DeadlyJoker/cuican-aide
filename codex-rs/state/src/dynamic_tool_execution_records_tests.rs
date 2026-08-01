use pretty_assertions::assert_eq;

use crate::DynamicToolExecutionClaimInput;
use crate::DynamicToolExecutionCompletionRecord;
use crate::DynamicToolExecutionFailureCode;
use crate::DynamicToolExecutionOperation;
use crate::DynamicToolExecutionRecord;
use crate::DynamicToolExecutionRecordErrorKind;
use crate::DynamicToolExecutionResultRecord;
use crate::DynamicToolExecutionTerminalRecord;
use crate::DynamicToolExecutionUnknownCode;
use crate::ProviderResourceExecutionLocation;
use crate::ProviderResourceKind;
use crate::ProviderResourceWorkspaceScope;

#[test]
fn dynamic_tool_claim_is_strict_hash_bound_and_debug_redacted() {
    let input = claim_input();
    let input_debug = format!("{input:?}");
    for sensitive in [
        input.actor_id.as_str(),
        input.trace_id.as_str(),
        input.span_id.as_str(),
        input.workspace_key.as_str(),
        input.connection_id.as_str(),
        input.resource_id.as_str(),
        input.credential_id.as_deref().expect("credential"),
        input.action_digest.as_str(),
    ] {
        assert!(!input_debug.contains(sensitive));
    }

    let record = DynamicToolExecutionRecord::claimed(input).expect("claim");
    record.validate().expect("valid claim");
    let debug = format!("{record:?}");
    for sensitive in [
        record.actor_id.as_str(),
        record.tenant_id.as_str(),
        record.space_id.as_str(),
        record.workspace_key.as_str(),
        record.connection_id.as_str(),
        record.resource_id.as_str(),
        record.credential_id.as_deref().expect("credential"),
        record.action_digest.as_str(),
        record.claim_hash.as_str(),
        record.record_hash.as_str(),
    ] {
        assert!(!debug.contains(sensitive));
    }

    let mut tampered = record.clone();
    tampered.resource_revision = "resource-version:8".to_string();
    assert_eq!(
        tampered.validate().expect_err("tampered claim").kind(),
        DynamicToolExecutionRecordErrorKind::DigestMismatch
    );

    let duplicate = claimed();
    assert!(record.same_claim(&duplicate));
    let mut conflict = claimed();
    conflict.action_digest =
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string();
    conflict.claim_hash = conflict.canonical_claim_hash();
    conflict.record_hash = conflict.canonical_hash();
    assert!(!record.same_claim(&conflict));
}

#[test]
fn dynamic_tool_completion_is_terminal_bounded_and_audit_correlated() {
    let claim = claimed();
    let succeeded = claim
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
            "event-dynamic-tool-1",
            110,
        )
        .expect("successful completion");
    assert!(matches!(
        succeeded.terminal,
        DynamicToolExecutionTerminalRecord::Succeeded(DynamicToolExecutionResultRecord::Inline {
            item_count: 2,
            byte_len: 120,
            ..
        })
    ));
    assert_eq!(
        succeeded
            .complete(
                DynamicToolExecutionCompletionRecord::Unknown(
                    DynamicToolExecutionUnknownCode::Timeout,
                ),
                "event-second",
                120,
            )
            .expect_err("terminal completion cannot change")
            .kind(),
        DynamicToolExecutionRecordErrorKind::InvalidTransition
    );

    let failed = claimed()
        .complete(
            DynamicToolExecutionCompletionRecord::Failed(
                DynamicToolExecutionFailureCode::ExecutionFailed,
            ),
            "event-dynamic-tool-failed",
            111,
        )
        .expect("failed completion");
    assert_eq!(
        failed.terminal,
        DynamicToolExecutionTerminalRecord::Failed(
            DynamicToolExecutionFailureCode::ExecutionFailed
        )
    );

    let unknown = claimed()
        .complete(
            DynamicToolExecutionCompletionRecord::Unknown(
                DynamicToolExecutionUnknownCode::AdapterUnavailable,
            ),
            "event-dynamic-tool-unknown",
            112,
        )
        .expect("unknown completion");
    assert_eq!(
        unknown.terminal,
        DynamicToolExecutionTerminalRecord::Unknown(
            DynamicToolExecutionUnknownCode::AdapterUnavailable
        )
    );
}

#[test]
fn dynamic_tool_record_rejects_authority_result_and_operation_mismatch() {
    let mut no_credential = claim_input();
    no_credential.credential_id = None;
    no_credential.credential_revision = None;
    assert_eq!(
        DynamicToolExecutionRecord::claimed(no_credential)
            .expect_err("Provider execution requires a Credential")
            .kind(),
        DynamicToolExecutionRecordErrorKind::InconsistentFields
    );

    let mut wrong_operation = claim_input();
    wrong_operation.resource_kind = ProviderResourceKind::KnowledgeBase;
    assert_eq!(
        DynamicToolExecutionRecord::claimed(wrong_operation)
            .expect_err("Knowledge must use search")
            .kind(),
        DynamicToolExecutionRecordErrorKind::InconsistentFields
    );

    let oversized = claimed()
        .complete(
            DynamicToolExecutionCompletionRecord::Succeeded(
                DynamicToolExecutionResultRecord::Inline {
                    item_count: 17,
                    byte_len: 120,
                    sha256:
                        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
                            .to_string(),
                },
            ),
            "event-oversized",
            110,
        )
        .expect_err("result cap");
    assert_eq!(
        oversized.kind(),
        DynamicToolExecutionRecordErrorKind::OutOfRange
    );
}

fn claimed() -> DynamicToolExecutionRecord {
    DynamicToolExecutionRecord::claimed(claim_input()).expect("claim")
}

fn claim_input() -> DynamicToolExecutionClaimInput {
    DynamicToolExecutionClaimInput {
        call_id: "call-1".to_string(),
        action_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            .to_string(),
        access_decision_id: "decision-1".to_string(),
        approval_id: Some("approval-1".to_string()),
        actor_id: "actor-1".to_string(),
        tenant_id: "tenant-1".to_string(),
        space_id: "space-1".to_string(),
        session_id: "session-1".to_string(),
        trace_id: "trace-1".to_string(),
        span_id: "span-dynamic-tool-1".to_string(),
        parent_span_id: Some("span-parent-1".to_string()),
        thread_id: "thread-1".to_string(),
        turn_id: "turn-1".to_string(),
        workspace_key: "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c001".to_string(),
        workspace_binding_id: "workspace-binding-1".to_string(),
        workspace_scope: ProviderResourceWorkspaceScope::Office,
        workspace_scope_id: "office-1".to_string(),
        binding_id: "resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c301".to_string(),
        binding_revision: 1,
        connection_id: "provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101".to_string(),
        provider_id: "agent-platform".to_string(),
        protocol_version: "3.0.0".to_string(),
        resource_kind: ProviderResourceKind::McpTool,
        resource_id: "resource-9".to_string(),
        resource_revision: "resource-version:7".to_string(),
        execution_location: ProviderResourceExecutionLocation::Provider,
        credential_id: Some("provider-grant-1".to_string()),
        credential_revision: Some(1),
        provider_identity_binding_id: Some("identity-binding-1".to_string()),
        provider_identity_binding_revision: Some(1),
        provider_subject: Some("user:42".to_string()),
        provider_tenant_id: Some("7".to_string()),
        provider_space_id: Some("11".to_string()),
        operation: DynamicToolExecutionOperation::Call,
        created_at: 100,
    }
}
