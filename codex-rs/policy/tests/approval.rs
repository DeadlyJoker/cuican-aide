#![allow(
    clippy::expect_used,
    reason = "integration-test setup uses expect for precise state-machine failures"
)]

use crewon_policy::AccessDecisionId;
use crewon_policy::ActionCredentialRef;
use crewon_policy::ActionIntent;
use crewon_policy::ActionIntentSpec;
use crewon_policy::ActionNonce;
use crewon_policy::ActionPurpose;
use crewon_policy::ActionTarget;
use crewon_policy::ActionTargetId;
use crewon_policy::ActionType;
use crewon_policy::ActionWorkspace;
use crewon_policy::ApprovalDecision;
use crewon_policy::ApprovalError;
use crewon_policy::ApprovalId;
use crewon_policy::ApprovalLedger;
use crewon_policy::ApprovalLedgerSnapshot;
use crewon_policy::ApprovalStatus;
use crewon_policy::BaselinePolicy;
use crewon_policy::CredentialBinding;
use crewon_policy::CredentialExpiry;
use crewon_policy::CredentialState;
use crewon_policy::MAX_APPROVAL_RECORDS;
use crewon_policy::PolicyActor;
use crewon_policy::PolicyDecision;
use crewon_policy::PolicyDenialReason;
use crewon_policy::SideEffect;
use crewon_policy::WorkspaceScopeKind;
use crewon_resource_federation::ExecutionLocation;
use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderProtocolVersion;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceRevision;
use crewon_resource_federation::WorkspaceKey;
use pretty_assertions::assert_eq;
use serde_json::json;

#[test]
fn baseline_policy_returns_only_allow_deny_or_approval_required() {
    let read_only = action(
        "workspace-1",
        "rev-1",
        SideEffect::ReadOnly,
        /*expires_at*/ 100,
    );
    let write = action(
        "workspace-1",
        "rev-1",
        SideEffect::ExternalWrite,
        /*expires_at*/ 100,
    );
    let expired = action(
        "workspace-1",
        "rev-1",
        SideEffect::ReadOnly,
        /*expires_at*/ 10,
    );

    let allow = BaselinePolicy::evaluate(access_id("decision-allow"), &read_only, /*now*/ 50)
        .expect("allow decision");
    let approval =
        BaselinePolicy::evaluate(access_id("decision-approval"), &write, /*now*/ 50)
            .expect("approval decision");
    let deny = BaselinePolicy::evaluate(access_id("decision-deny"), &expired, /*now*/ 50)
        .expect("deny decision");

    assert!(matches!(allow, PolicyDecision::Allow(_)));
    assert_eq!(
        allow
            .execution_authorization()
            .expect("immediate authorization")
            .approval_id(),
        None
    );
    assert!(matches!(approval, PolicyDecision::ApprovalRequired(_)));
    assert!(approval.execution_authorization().is_none());
    assert!(matches!(
        deny,
        PolicyDecision::Deny(ref denial)
            if denial.reason() == PolicyDenialReason::ActionExpired
    ));
    assert!(deny.execution_authorization().is_none());
}

#[test]
fn approval_is_bound_to_owner_current_action_and_single_consumption() {
    let original = action(
        "workspace-1",
        "rev-1",
        SideEffect::ExternalWrite,
        /*expires_at*/ 100,
    );
    let requirement = approval_requirement(&original, "decision-1", /*now*/ 10);
    let approval_id = ApprovalId::new("approval-1").expect("approval id");
    let mut ledger = ApprovalLedger::new();

    let first = ledger
        .request(approval_id.clone(), requirement.clone(), /*now*/ 10)
        .expect("request approval");
    let duplicate = ledger
        .request(approval_id.clone(), requirement, /*now*/ 10)
        .expect("idempotent request");
    assert_eq!(first, duplicate);
    assert_eq!(ledger.len(), 1);

    let other_owner =
        PolicyActor::space_user("actor-2", "tenant-1", "space-1").expect("other owner");
    assert_eq!(
        ledger.decide(
            &approval_id,
            &other_owner,
            original.digest().expect("digest"),
            ApprovalDecision::Approve,
            /*now*/ 20,
        ),
        Err(ApprovalError::OwnerMismatch)
    );

    let approved = ledger
        .decide(
            &approval_id,
            original.actor(),
            original.digest().expect("digest"),
            ApprovalDecision::Approve,
            /*now*/ 20,
        )
        .expect("approve");
    assert_eq!(approved.status(), ApprovalStatus::Approved);
    assert_eq!(
        ledger
            .decide(
                &approval_id,
                original.actor(),
                original.digest().expect("digest"),
                ApprovalDecision::Approve,
                /*now*/ 20,
            )
            .expect("idempotent approve"),
        approved
    );

    let changed_workspace = action(
        "workspace-2",
        "rev-1",
        SideEffect::ExternalWrite,
        /*expires_at*/ 100,
    );
    assert_eq!(
        ledger.consume(
            &approval_id,
            original.actor(),
            &changed_workspace,
            /*now*/ 30,
        ),
        Err(ApprovalError::ActionDigestMismatch)
    );

    let authorization = ledger
        .consume(&approval_id, original.actor(), &original, /*now*/ 30)
        .expect("consume approval");
    let authorization = authorization
        .verify(&original, /*now*/ 30)
        .expect("authorization matches current action");
    assert_eq!(authorization.approval_id(), Some(&approval_id));
    let mut external_side_effects = 0;
    execute_once(authorization, &mut external_side_effects);
    assert_eq!(
        ledger.consume(&approval_id, original.actor(), &original, /*now*/ 30),
        Err(ApprovalError::AlreadyConsumed)
    );
    assert_eq!(external_side_effects, 1);
}

#[test]
fn nonce_replay_conflicting_decisions_and_expiry_fail_closed() {
    let original = action(
        "workspace-1",
        "rev-1",
        SideEffect::ExternalWrite,
        /*expires_at*/ 100,
    );
    let requirement = approval_requirement(&original, "decision-1", /*now*/ 10);
    let mut ledger = ApprovalLedger::new();
    let first_id = ApprovalId::new("approval-1").expect("first id");
    ledger
        .request(first_id.clone(), requirement.clone(), /*now*/ 10)
        .expect("first request");

    assert_eq!(
        ledger.request(
            ApprovalId::new("approval-2").expect("second id"),
            requirement,
            /*now*/ 10,
        ),
        Err(ApprovalError::NonceReplay)
    );

    ledger
        .decide(
            &first_id,
            original.actor(),
            original.digest().expect("digest"),
            ApprovalDecision::Approve,
            /*now*/ 20,
        )
        .expect("approve");
    assert_eq!(
        ledger.decide(
            &first_id,
            original.actor(),
            original.digest().expect("digest"),
            ApprovalDecision::Deny,
            /*now*/ 20,
        ),
        Err(ApprovalError::ConflictingDecision)
    );
    assert_eq!(
        ledger.consume(&first_id, original.actor(), &original, /*now*/ 100),
        Err(ApprovalError::Expired)
    );
    assert_eq!(
        ledger.record(&first_id).expect("expired record").status(),
        ApprovalStatus::Expired
    );
}

#[test]
fn snapshot_restore_preserves_nonce_and_consumption_fences() {
    let original = action(
        "workspace-1",
        "rev-1",
        SideEffect::ExternalWrite,
        /*expires_at*/ 100,
    );
    let requirement = approval_requirement(&original, "decision-1", /*now*/ 10);
    let approval_id = ApprovalId::new("approval-1").expect("approval id");
    let mut ledger = ApprovalLedger::new();
    ledger
        .request(approval_id.clone(), requirement.clone(), /*now*/ 10)
        .expect("request");
    ledger
        .decide(
            &approval_id,
            original.actor(),
            original.digest().expect("digest"),
            ApprovalDecision::Approve,
            /*now*/ 20,
        )
        .expect("approve");
    ledger
        .consume(&approval_id, original.actor(), &original, /*now*/ 30)
        .expect("consume");

    let serialized = serde_json::to_vec(&ledger.snapshot()).expect("serialize snapshot");
    assert!(!String::from_utf8_lossy(&serialized).contains("dist/app.tar"));
    let snapshot: ApprovalLedgerSnapshot =
        serde_json::from_slice(&serialized).expect("deserialize snapshot");
    let mut restored = ApprovalLedger::restore(snapshot).expect("restore ledger");

    assert_eq!(
        restored.consume(&approval_id, original.actor(), &original, /*now*/ 40),
        Err(ApprovalError::AlreadyConsumed)
    );
    assert_eq!(
        restored.request(
            ApprovalId::new("approval-2").expect("second id"),
            requirement,
            /*now*/ 40,
        ),
        Err(ApprovalError::NonceReplay)
    );
}

#[test]
fn credential_rotation_invalidates_approval_and_revocation_is_denied() {
    let original = credential_action(/*revision*/ 7, CredentialState::Available);
    let rotated = credential_action(/*revision*/ 8, CredentialState::Available);
    let revoked = credential_action(/*revision*/ 7, CredentialState::Revoked);
    let approval_id = ApprovalId::new("approval-credential").expect("approval id");
    let mut ledger = ApprovalLedger::new();
    ledger
        .request(
            approval_id.clone(),
            approval_requirement(&original, "decision-credential", /*now*/ 10),
            /*now*/ 10,
        )
        .expect("request");
    ledger
        .decide(
            &approval_id,
            original.actor(),
            original.digest().expect("digest"),
            ApprovalDecision::Approve,
            /*now*/ 20,
        )
        .expect("approve");

    assert_eq!(
        ledger.consume(&approval_id, original.actor(), &rotated, /*now*/ 30),
        Err(ApprovalError::ActionDigestMismatch)
    );
    assert!(matches!(
        BaselinePolicy::evaluate(access_id("decision-revoked"), &revoked, /*now*/ 30)
            .expect("revoked decision"),
        PolicyDecision::Deny(ref denial)
            if denial.reason() == PolicyDenialReason::CredentialUnavailable
    ));
}

#[test]
fn snapshot_deserialization_and_restore_reject_unbounded_or_impossible_state() {
    let original = action(
        "workspace-1",
        "rev-1",
        SideEffect::ExternalWrite,
        /*expires_at*/ 100,
    );
    let mut ledger = ApprovalLedger::new();
    ledger
        .request(
            ApprovalId::new("approval-1").expect("approval id"),
            approval_requirement(&original, "decision-1", /*now*/ 10),
            /*now*/ 10,
        )
        .expect("request");
    let snapshot = serde_json::to_value(ledger.snapshot()).expect("snapshot value");

    let mut impossible = snapshot.clone();
    impossible["records"][0]["status"] = json!("consumed");
    let impossible: ApprovalLedgerSnapshot =
        serde_json::from_value(impossible).expect("deserialize bounded shape");
    assert_eq!(
        ApprovalLedger::restore(impossible).expect_err("reject impossible state"),
        ApprovalError::InvalidSnapshot
    );

    let record = snapshot["records"][0].clone();
    let oversized = json!({
        "records": vec![record; MAX_APPROVAL_RECORDS.saturating_add(1)]
    });
    assert!(serde_json::from_value::<ApprovalLedgerSnapshot>(oversized).is_err());
}

fn approval_requirement(
    action: &ActionIntent,
    decision_id: &str,
    now: i64,
) -> crewon_policy::ApprovalRequirement {
    match BaselinePolicy::evaluate(access_id(decision_id), action, now).expect("policy decision") {
        PolicyDecision::ApprovalRequired(requirement) => requirement,
        PolicyDecision::Allow(_) | PolicyDecision::Deny(_) => {
            panic!("expected approval requirement")
        }
    }
}

fn action(
    workspace_key: &str,
    target_revision: &str,
    side_effect: SideEffect,
    expires_at: i64,
) -> ActionIntent {
    action_with_credential(
        workspace_key,
        target_revision,
        side_effect,
        expires_at,
        CredentialBinding::None,
    )
}

fn credential_action(revision: u64, status: CredentialState) -> ActionIntent {
    action_with_credential(
        "workspace-1",
        "rev-1",
        SideEffect::ExternalWrite,
        /*expires_at*/ 100,
        CredentialBinding::Reference(
            ActionCredentialRef::new(
                "cred-1",
                ProviderId::new("provider-1").expect("provider"),
                status,
                revision,
                CredentialExpiry::At(90),
            )
            .expect("credential"),
        ),
    )
}

fn action_with_credential(
    workspace_key: &str,
    target_revision: &str,
    side_effect: SideEffect,
    expires_at: i64,
    credential: CredentialBinding,
) -> ActionIntent {
    ActionIntent::new(ActionIntentSpec {
        action_type: ActionType::ToolCall,
        actor: PolicyActor::space_user("actor-1", "tenant-1", "space-1").expect("actor"),
        purpose: ActionPurpose::new("release.publish").expect("purpose"),
        workspace: ActionWorkspace::new(
            WorkspaceKey::new(workspace_key).expect("workspace key"),
            "binding-1",
            WorkspaceScopeKind::Office,
            "office-1",
            "node-1",
            "environment-1",
        )
        .expect("workspace"),
        target: ActionTarget::tool(
            ProviderRef {
                provider_id: ProviderId::new("provider-1").expect("provider"),
                protocol_version: ProviderProtocolVersion::new("1").expect("protocol revision"),
            },
            ActionTargetId::new("tool-1").expect("tool id"),
            ResourceRevision::new(target_revision).expect("tool revision"),
        ),
        arguments: json!({"path": "dist/app.tar"}),
        credential,
        execution_location: ExecutionLocation::Provider,
        side_effect,
        expires_at,
        nonce: ActionNonce::new("nonce-1").expect("nonce"),
    })
    .expect("action")
}

fn access_id(value: &str) -> AccessDecisionId {
    AccessDecisionId::new(value).expect("access decision id")
}

fn execute_once(
    _authorization: crewon_policy::ExecutionAuthorization,
    external_side_effects: &mut usize,
) {
    *external_side_effects = external_side_effects.saturating_add(1);
}
