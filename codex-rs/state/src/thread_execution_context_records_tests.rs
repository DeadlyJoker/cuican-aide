use pretty_assertions::assert_eq;

use crate::MAX_THREAD_EXECUTION_CONTEXT_BINDINGS;
use crate::ProviderResourceWorkspaceScope;
use crate::ThreadExecutionContextBindingRef;
use crate::ThreadExecutionContextRecord;
use crate::ThreadExecutionContextRecordErrorKind;

#[test]
fn thread_execution_context_is_digest_bound_sorted_and_bounded() {
    let record = context_record();
    record.validate().expect("valid Thread execution context");

    let mut tampered = record.clone();
    tampered.updated_at = 101;
    assert_eq!(
        tampered.validate().expect_err("digest mismatch").kind(),
        ThreadExecutionContextRecordErrorKind::DigestMismatch
    );

    let mut wrong_scope = record.clone();
    wrong_scope.workspace_scope_id = "thread-other".to_string();
    wrong_scope.record_hash = wrong_scope.canonical_hash();
    assert_eq!(
        wrong_scope.validate().expect_err("scope mismatch").kind(),
        ThreadExecutionContextRecordErrorKind::InconsistentFields
    );

    let mut duplicate = record.clone();
    duplicate
        .resource_bindings
        .push(duplicate.resource_bindings[0].clone());
    duplicate.record_hash = duplicate.canonical_hash();
    assert_eq!(
        duplicate.validate().expect_err("duplicate binding").kind(),
        ThreadExecutionContextRecordErrorKind::Duplicate
    );

    let mut oversized = record;
    oversized.resource_bindings = (0..=MAX_THREAD_EXECUTION_CONTEXT_BINDINGS)
        .map(|index| ThreadExecutionContextBindingRef {
            binding_id: format!(
                "resource-binding:{}",
                uuid::Uuid::from_u128(index as u128 + 1)
            ),
            revision: 1,
        })
        .collect();
    oversized.record_hash = oversized.canonical_hash();
    assert_eq!(
        oversized.validate().expect_err("binding cap").kind(),
        ThreadExecutionContextRecordErrorKind::TooManyItems
    );
}

#[test]
fn office_execution_context_allows_distinct_manager_and_member_threads() {
    for thread_id in ["office-manager-thread", "office-member-thread"] {
        let mut record = context_record();
        record.thread_id = thread_id.to_string();
        record.workspace_scope = ProviderResourceWorkspaceScope::Office;
        record.workspace_scope_id = "office-1".to_string();
        record.record_hash = record.canonical_hash();

        record.validate().expect("valid Office execution context");
    }
}

#[test]
fn execution_context_rejects_unsupported_collaboration_scopes() {
    for workspace_scope in [
        ProviderResourceWorkspaceScope::Workflow,
        ProviderResourceWorkspaceScope::Automation,
    ] {
        let mut record = context_record();
        record.workspace_scope = workspace_scope;
        record.workspace_scope_id = "unsupported-scope-1".to_string();
        record.record_hash = record.canonical_hash();

        assert_eq!(
            record
                .validate()
                .expect_err("unsupported execution context scope")
                .kind(),
            ThreadExecutionContextRecordErrorKind::InconsistentFields
        );
    }
}

#[test]
fn execution_binding_must_be_one_exact_resource_binding_revision() {
    let base = context_record();
    let legacy_hash = base.record_hash.clone();
    let exact = base.resource_bindings[0].clone();

    let mut bound = base.clone();
    bound.execution_binding = Some(exact.clone());
    bound.record_hash = bound.canonical_hash();
    bound.validate().expect("exact execution binding");
    assert_ne!(bound.record_hash, legacy_hash);
    assert!(!format!("{bound:?}").contains(&exact.binding_id));

    let mut missing = base.clone();
    missing.execution_binding = Some(ThreadExecutionContextBindingRef {
        binding_id: "resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c999".to_string(),
        revision: 1,
    });
    missing.record_hash = missing.canonical_hash();
    assert_eq!(
        missing
            .validate()
            .expect_err("execution binding outside resource set")
            .kind(),
        ThreadExecutionContextRecordErrorKind::InconsistentFields
    );

    let mut revision_drift = base;
    revision_drift.execution_binding = Some(ThreadExecutionContextBindingRef {
        binding_id: exact.binding_id,
        revision: 2,
    });
    revision_drift.record_hash = revision_drift.canonical_hash();
    assert_eq!(
        revision_drift
            .validate()
            .expect_err("execution binding revision drift")
            .kind(),
        ThreadExecutionContextRecordErrorKind::InconsistentFields
    );
}

pub(crate) fn context_record() -> ThreadExecutionContextRecord {
    let mut record = ThreadExecutionContextRecord {
        thread_id: "019f550e-ba52-7490-a248-b0d3a84103c1".to_string(),
        local_actor_id: "actor-1".to_string(),
        local_tenant_id: "tenant-1".to_string(),
        local_space_id: "space-1".to_string(),
        workspace_key: "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c001".to_string(),
        workspace_scope: ProviderResourceWorkspaceScope::Conversation,
        workspace_scope_id: "019f550e-ba52-7490-a248-b0d3a84103c1".to_string(),
        resource_bindings: vec![ThreadExecutionContextBindingRef {
            binding_id: "resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c401".to_string(),
            revision: 1,
        }],
        execution_binding: None,
        revision: 1,
        record_hash: String::new(),
        created_at: 100,
        updated_at: 100,
    };
    record.record_hash = record.canonical_hash();
    record
}
