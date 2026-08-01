use std::collections::BTreeMap;
use std::sync::Mutex;

use crewon_app_server_protocol::WorkspaceRef;
use crewon_app_server_protocol::WorkspaceScope;
use crewon_policy::*;
use crewon_resource_federation::ProviderId;
use crewon_state::*;
use pretty_assertions::assert_eq;
use serde_json::json;

use super::dynamic_tool_router::execution::*;
use super::dynamic_tool_router::ports::DynamicToolExecutionClaimOutcome as PortClaimOutcome;
use super::dynamic_tool_router::ports::DynamicToolExecutionCompletionOutcome as PortCompletionOutcome;
use super::dynamic_tool_router::ports::*;
use super::dynamic_tool_router::registration::*;
use super::dynamic_tool_router_tests::binding;
use super::provider_identity_adapter_tests::authenticated_identity;

#[tokio::test]
async fn read_only_call_claims_once_and_returns_move_only_target() {
    let harness = Harness::new();
    let invocation = harness.invocation("call-1", json!({"query": "hello"}));
    let first = harness
        .admit(
            invocation.clone(),
            policy("nonce-1"),
            DynamicToolAuthorization::Evaluate(decision("decision-1")),
        )
        .await
        .expect("first admission");
    let DynamicToolAdmissionOutcome::Authorized(authorized) = first else {
        panic!("expected authorized call");
    };
    assert!(matches!(
        authorized.target(),
        DynamicToolExecutionTarget::Provider { .. }
    ));
    assert_eq!(authorized.arguments(), &json!({"query": "hello"}));
    assert_eq!(authorized.claim().request().binding_revision, 1);
    assert_eq!(
        authorized.claim().request().credential_id.as_deref(),
        Some("provider-grant-1")
    );
    assert_eq!(authorized.claim().request().credential_revision, Some(1));
    assert_eq!(authorized.claim().request().approval_id, None);
    assert_eq!(
        authorized.claim().request().workspace_scope,
        WorkspaceScope::Office
    );
    assert!(!format!("{authorized:?}").contains("hello"));

    let duplicate = harness
        .admit(
            invocation,
            policy("nonce-1"),
            DynamicToolAuthorization::Evaluate(decision("decision-2")),
        )
        .await
        .expect("same action is deduplicated");
    assert!(matches!(duplicate, DynamicToolAdmissionOutcome::Duplicate));
    assert_eq!(harness.journal.claims().len(), 1);

    assert_eq!(
        harness
            .admit(
                harness.invocation("call-1", json!({"query": "changed"})),
                policy("nonce-conflict"),
                DynamicToolAuthorization::Evaluate(decision("decision-conflict")),
            )
            .await
            .expect_err("same call ID with another digest"),
        DynamicToolAdmissionError::CallConflict
    );
}

#[tokio::test]
async fn mutation_without_approval_is_not_claimed_and_argument_change_invalidates_approval() {
    let harness = Harness::with_side_effect(SideEffect::ExternalWrite);
    let authorization = approved_authorization(
        &harness,
        "call-approved",
        json!({"value": 1}),
        "nonce-approved",
    )
    .await;
    let approved = harness
        .admit(
            harness.invocation("call-approved", json!({"value": 1})),
            policy("nonce-approved"),
            DynamicToolAuthorization::Presented(authorization),
        )
        .await
        .expect("approved action");
    let DynamicToolAdmissionOutcome::Authorized(approved) = approved else {
        panic!("expected approved call");
    };
    assert_eq!(
        approved.claim().request().approval_id.as_deref(),
        Some("approval-1")
    );
    assert_eq!(harness.journal.claims().len(), 1);

    let mismatch = Harness::with_side_effect(SideEffect::ExternalWrite);
    let authorization = approved_authorization(
        &mismatch,
        "call-approval-mismatch",
        json!({"value": 1}),
        "nonce-approval-mismatch",
    )
    .await;
    assert_eq!(
        mismatch
            .admit(
                mismatch.invocation("call-approval-mismatch", json!({"value": 2})),
                policy("nonce-approval-mismatch"),
                DynamicToolAuthorization::Presented(authorization),
            )
            .await
            .expect_err("changed arguments invalidate approval"),
        DynamicToolAdmissionError::Authorization(AuthorizationError::ActionDigestMismatch)
    );
    assert!(mismatch.journal.claims().is_empty());
}

async fn approved_authorization(
    harness: &Harness,
    call_id: &str,
    arguments: serde_json::Value,
    nonce: &str,
) -> ExecutionAuthorization {
    let pending = harness
        .admit(
            harness.invocation(call_id, arguments),
            policy(nonce),
            DynamicToolAuthorization::Evaluate(decision("decision-approval")),
        )
        .await
        .expect("approval requirement");
    let DynamicToolAdmissionOutcome::ApprovalRequired {
        action,
        requirement,
    } = pending
    else {
        panic!("expected approval requirement");
    };
    let actor = harness.identity.policy_actor().expect("policy actor");
    let approval_id = ApprovalId::new("approval-1").expect("approval id");
    let digest = requirement.action_digest().clone();
    let mut ledger = ApprovalLedger::new();
    ledger
        .request(approval_id.clone(), requirement, /*now*/ 10)
        .expect("request approval");
    ledger
        .decide(
            &approval_id,
            &actor,
            digest,
            ApprovalDecision::Approve,
            /*now*/ 11,
        )
        .expect("approve action");
    ledger
        .consume(&approval_id, &actor, &action, /*now*/ 12)
        .expect("consume approval")
}

#[tokio::test]
async fn revoke_owner_and_binding_drift_fail_before_claim() {
    let harness = Harness::new();
    *harness.credentials.status.lock().expect("credential lock") = CredentialState::Revoked;
    assert!(matches!(
        harness
            .admit(
                harness.invocation("call-revoked", json!({})),
                policy("nonce-revoked"),
                DynamicToolAuthorization::Evaluate(decision("decision-revoked")),
            )
            .await
            .expect("policy denial"),
        DynamicToolAdmissionOutcome::Denied(_)
    ));

    *harness.credentials.status.lock().expect("credential lock") = CredentialState::Available;
    let mut wrong_workspace = harness.workspace.clone();
    wrong_workspace.scope_id = "office-other".to_string();
    assert_eq!(
        harness
            .admit_in_workspace(
                &wrong_workspace,
                harness.invocation("call-owner", json!({})),
                policy("nonce-owner"),
                DynamicToolAuthorization::Evaluate(decision("decision-owner")),
            )
            .await
            .expect_err("workspace mismatch"),
        DynamicToolAdmissionError::AuthorityMismatch
    );

    let mut drifted = harness.record.clone();
    drifted.revision = 3;
    drifted.updated_at += 1;
    drifted.record_hash = drifted.canonical_hash();
    *harness.bindings.record.lock().expect("binding lock") = drifted;
    assert_eq!(
        harness
            .admit(
                harness.invocation("call-drift", json!({})),
                policy("nonce-drift"),
                DynamicToolAuthorization::Evaluate(decision("decision-drift")),
            )
            .await
            .expect_err("binding drift"),
        DynamicToolAdmissionError::Route(DynamicToolRouteError::BindingDrift)
    );
    assert!(harness.journal.claims().is_empty());
}

#[tokio::test]
async fn provider_route_requires_a_server_owned_credential_snapshot() {
    let harness = Harness::new();
    *harness
        .credentials
        .has_reference
        .lock()
        .expect("credential reference lock") = false;
    assert_eq!(
        harness
            .admit(
                harness.invocation("call-no-credential", json!({})),
                policy("nonce-no-credential"),
                DynamicToolAuthorization::Evaluate(decision("decision-no-credential")),
            )
            .await
            .expect_err("Provider execution requires a Credential"),
        DynamicToolAdmissionError::CredentialRequired
    );
    assert!(harness.journal.claims().is_empty());
}

pub(super) struct Harness {
    identity: super::RequestIdentity,
    workspace: WorkspaceRef,
    record: ProviderResourceBindingRecord,
    registry: DynamicToolRegistry,
    bindings: FakeBindingReader,
    credentials: FakeCredentialResolver,
    journal: FakeJournal,
    side_effect: SideEffect,
}

impl Harness {
    pub(super) fn new() -> Self {
        Self::with_side_effect(SideEffect::ReadOnly)
    }

    fn with_side_effect(side_effect: SideEffect) -> Self {
        Self::build(side_effect, ProviderResourceBindingMode::ProviderManaged)
    }

    fn build(side_effect: SideEffect, binding_mode: ProviderResourceBindingMode) -> Self {
        let identity = authenticated_identity("dynamic-tool-admission");
        let mut record = binding(ProviderResourceKind::McpTool, binding_mode);
        record.local_actor_id = identity.reference().actor_id.clone();
        record.local_tenant_id = identity.reference().tenant_id.clone().expect("tenant");
        record.local_space_id = identity.reference().space_id.clone().expect("space");
        record.record_hash = record.canonical_hash();
        let registration = DynamicToolRegistration::from_binding(record.clone(), side_effect)
            .expect("registration");
        Self {
            identity,
            workspace: workspace(),
            registry: DynamicToolRegistry::from_registrations([registration]).expect("registry"),
            bindings: FakeBindingReader {
                record: Mutex::new(record.clone()),
            },
            credentials: FakeCredentialResolver {
                status: Mutex::new(CredentialState::Available),
                has_reference: Mutex::new(true),
            },
            journal: FakeJournal::default(),
            side_effect,
            record,
        }
    }

    fn invocation(&self, call_id: &str, arguments: serde_json::Value) -> DynamicToolInvocation {
        let registration =
            DynamicToolRegistration::from_binding(self.record.clone(), self.side_effect)
                .expect("registration");
        DynamicToolInvocation::new(
            call_id,
            registration.namespace(),
            registration.tool_name(),
            arguments,
        )
        .expect("invocation")
    }

    pub(super) async fn authorized(
        &self,
        call_id: &str,
        arguments: serde_json::Value,
    ) -> DynamicToolAuthorizedCall {
        let outcome = self
            .admit(
                self.invocation(call_id, arguments),
                policy(&format!("nonce-{call_id}")),
                DynamicToolAuthorization::Evaluate(decision(&format!("decision-{call_id}"))),
            )
            .await
            .expect("authorized admission");
        let DynamicToolAdmissionOutcome::Authorized(authorized) = outcome else {
            panic!("expected authorized call");
        };
        *authorized
    }

    pub(super) fn journal(&self) -> &FakeJournal {
        &self.journal
    }

    async fn admit(
        &self,
        invocation: DynamicToolInvocation,
        policy: DynamicToolPolicyContext,
        authorization: DynamicToolAuthorization,
    ) -> Result<DynamicToolAdmissionOutcome, DynamicToolAdmissionError> {
        self.admit_in_workspace(&self.workspace, invocation, policy, authorization)
            .await
    }

    async fn admit_in_workspace(
        &self,
        workspace: &WorkspaceRef,
        invocation: DynamicToolInvocation,
        policy: DynamicToolPolicyContext,
        authorization: DynamicToolAuthorization,
    ) -> Result<DynamicToolAdmissionOutcome, DynamicToolAdmissionError> {
        DynamicToolAdmissionRouter::new(
            &self.registry,
            &self.bindings,
            &self.credentials,
            &self.journal,
        )
        .admit(
            &self.identity,
            workspace,
            invocation,
            policy,
            authorization,
            /*now*/ 20,
        )
        .await
    }
}

struct FakeBindingReader {
    record: Mutex<ProviderResourceBindingRecord>,
}

impl DynamicToolBindingReader for FakeBindingReader {
    async fn read_binding(
        &self,
        _binding_id: String,
    ) -> Result<Option<ProviderResourceBindingRecord>, DynamicToolPortError> {
        Ok(Some(self.record.lock().expect("binding lock").clone()))
    }
}

struct FakeCredentialResolver {
    status: Mutex<CredentialState>,
    has_reference: Mutex<bool>,
}

impl DynamicToolCredentialResolver for FakeCredentialResolver {
    async fn resolve_credential(
        &self,
        _request: DynamicToolCredentialRequest,
    ) -> Result<DynamicToolCredentialSnapshot, DynamicToolPortError> {
        if !*self
            .has_reference
            .lock()
            .expect("credential reference lock")
        {
            return Ok(DynamicToolCredentialSnapshot::none());
        }
        Ok(DynamicToolCredentialSnapshot::provider_reference(
            "provider-grant-1",
            ProviderId::new("agent-platform").expect("provider"),
            *self.status.lock().expect("credential lock"),
            /*revision*/ 1,
            CredentialExpiry::Never,
            DynamicToolProviderIdentitySnapshot {
                binding_id: "identity-binding-1".to_string(),
                binding_revision: 1,
                subject: "user:42".to_string(),
                tenant_id: "7".to_string(),
                space_id: "11".to_string(),
            },
        )
        .expect("credential"))
    }
}

#[derive(Default)]
pub(super) struct FakeJournal {
    claims: Mutex<BTreeMap<String, DynamicToolExecutionClaimRequest>>,
    completions: Mutex<BTreeMap<String, DynamicToolExecutionCompletionSnapshot>>,
    fail_completion: Mutex<bool>,
}

impl FakeJournal {
    pub(super) fn claims(&self) -> Vec<DynamicToolExecutionClaimRequest> {
        self.claims
            .lock()
            .expect("claims lock")
            .values()
            .cloned()
            .collect()
    }

    pub(super) fn completions(&self) -> Vec<DynamicToolExecutionCompletionSnapshot> {
        self.completions
            .lock()
            .expect("completions lock")
            .values()
            .cloned()
            .collect()
    }

    pub(super) fn single_completion(&self) -> DynamicToolExecutionCompletionSnapshot {
        let completions = self.completions();
        assert_eq!(completions.len(), 1);
        completions.into_iter().next().expect("completion")
    }

    pub(super) fn fail_completion(&self) {
        *self.fail_completion.lock().expect("completion flag lock") = true;
    }
}

impl DynamicToolExecutionJournal for FakeJournal {
    async fn claim(
        &self,
        request: DynamicToolExecutionClaimRequest,
    ) -> Result<PortClaimOutcome, DynamicToolPortError> {
        let mut claims = self.claims.lock().expect("claims lock");
        if let Some(existing) = claims.get(&request.call_id) {
            return Ok(if existing.same_execution(&request) {
                PortClaimOutcome::ExistingSame
            } else {
                PortClaimOutcome::Conflict
            });
        }
        claims.insert(request.call_id.clone(), request.clone());
        Ok(PortClaimOutcome::Acquired(Box::new(
            DynamicToolExecutionClaim::new(request),
        )))
    }

    async fn complete(
        &self,
        request: DynamicToolExecutionCompletion,
    ) -> Result<PortCompletionOutcome, DynamicToolPortError> {
        if *self.fail_completion.lock().expect("completion flag lock") {
            return Err(DynamicToolPortError::Unavailable);
        }
        let snapshot = request.snapshot();
        let Some(claimed) = self
            .claims
            .lock()
            .expect("claims lock")
            .get(&snapshot.claim().call_id)
            .cloned()
        else {
            return Ok(PortCompletionOutcome::Conflict);
        };
        if !claimed.same_execution(snapshot.claim()) {
            return Ok(PortCompletionOutcome::Conflict);
        }
        let mut completions = self.completions.lock().expect("completions lock");
        if completions.contains_key(&snapshot.claim().call_id) {
            return Ok(PortCompletionOutcome::Conflict);
        }
        completions.insert(snapshot.claim().call_id.clone(), snapshot);
        Ok(PortCompletionOutcome::Completed)
    }
}

fn workspace() -> WorkspaceRef {
    WorkspaceRef {
        workspace_key: "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c001".to_string(),
        binding_id: "workspace-binding-current".to_string(),
        scope: WorkspaceScope::Office,
        scope_id: "office-1".to_string(),
        node_id: "node-1".to_string(),
        environment_id: "local".to_string(),
    }
}

fn policy(nonce: &str) -> DynamicToolPolicyContext {
    DynamicToolPolicyContext {
        purpose: ActionPurpose::new("dynamicTool.execute").expect("purpose"),
        expires_at: 100,
        nonce: ActionNonce::new(nonce).expect("nonce"),
        execution: DynamicToolConversationExecution::new(
            format!("thread-{nonce}"),
            format!("turn-{nonce}"),
        )
        .expect("execution correlation"),
    }
}

fn decision(value: &str) -> AccessDecisionId {
    AccessDecisionId::new(value).expect("decision id")
}
