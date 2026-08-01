use super::*;
use crewon_resource_federation::BindingId;
use crewon_resource_federation::BindingMode;
use crewon_resource_federation::BindingRequest;
use crewon_resource_federation::Capability;
use crewon_resource_federation::ContentDigest;
use crewon_resource_federation::ExecutionLocation;
use crewon_resource_federation::ManifestSchemaVersion;
use crewon_resource_federation::ProviderCapabilities;
use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderProtocolVersion;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResourceId;
use crewon_resource_federation::ResourceKind;
use crewon_resource_federation::ResourceManifest;
use crewon_resource_federation::ResourceRef;
use crewon_resource_federation::ResourceRevision;
use crewon_resource_federation::WorkspaceKey;
use crewon_resource_federation::resolve_binding;
use pretty_assertions::assert_eq;

const HASH_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[test]
fn creates_a_complete_immutable_genesis_aggregate() {
    let contract = TaskContract::new(contract_spec(Vec::new())).expect("valid task contract");

    assert_eq!(
        TaskAggregate::new(contract.clone()),
        TaskAggregate {
            contract,
            status: TaskStatus::Created,
            suspension_reason: None,
            attempts: Vec::new(),
            active_attempt_id: None,
            aggregate_version: AggregateVersion::initial(),
            task_stream_offset: TaskStreamOffset::initial(),
            last_event_id: None,
            progress_count: 0,
        }
    );
}

#[test]
fn creates_a_complete_unclaimed_attempt_without_a_lease() {
    let attempt = Attempt::created(
        AttemptId::new("attempt-1").expect("attempt id"),
        AttemptOrdinal::new(1).expect("attempt ordinal"),
        IdempotencyKey::new("task-1:attempt-1").expect("idempotency key"),
    );

    assert_eq!(
        attempt,
        Attempt {
            attempt_id: AttemptId::new("attempt-1").expect("attempt id"),
            ordinal: AttemptOrdinal::new(1).expect("attempt ordinal"),
            idempotency_key: IdempotencyKey::new("task-1:attempt-1").expect("idempotency key"),
            status: AttemptStatus::Created,
            worker_run_id: None,
            lease: None,
            last_producer_sequence: None,
        }
    );
}

#[test]
fn task_contract_rejects_unbounded_resource_bindings() {
    let binding = resolved_binding();
    let bindings = (0..=MAX_TASK_BINDINGS)
        .map(|_| binding.clone())
        .collect::<Vec<_>>();

    assert_model_error(
        TaskContract::new(contract_spec(bindings)).expect_err("binding cap"),
        "bindings",
        ModelErrorKind::TooManyItems,
    );
}

#[test]
fn task_contract_rejects_duplicate_or_cross_workspace_bindings() {
    let binding = resolved_binding();
    assert_model_error(
        TaskContract::new(contract_spec(vec![binding.clone(), binding]))
            .expect_err("duplicate binding"),
        "bindingId",
        ModelErrorKind::Duplicate,
    );

    let mut spec = contract_spec(vec![resolved_binding()]);
    spec.workspace_key = WorkspaceKey::new("workspace-2").expect("workspace key");
    assert_model_error(
        TaskContract::new(spec).expect_err("binding workspace mismatch"),
        "bindingWorkspaceKey",
        ModelErrorKind::Mismatch,
    );
}

#[test]
fn task_contract_rejects_an_unsupported_schema_version() {
    let mut spec = contract_spec(Vec::new());
    spec.schema_version = TaskContractSchemaVersion::new("1").expect("old schema version");

    assert_model_error(
        TaskContract::new(spec).expect_err("unsupported schema version"),
        "schemaVersion",
        ModelErrorKind::Mismatch,
    );
}

#[test]
fn task_contract_canonicalizes_resource_binding_order() {
    let first = resolved_binding_named("binding-a", "agent-a");
    let second = resolved_binding_named("binding-b", "agent-b");
    let forward = TaskContract::new(contract_spec(vec![first.clone(), second.clone()]))
        .expect("forward contract");
    let reverse = TaskContract::new(contract_spec(vec![second, first])).expect("reverse contract");

    assert_eq!(forward, reverse);
}

#[test]
fn identifiers_hashes_and_numeric_guards_fail_closed() {
    assert_model_error(
        TaskId::new(" ").expect_err("empty task id"),
        "taskId",
        ModelErrorKind::Empty,
    );
    assert_model_error(
        EventId::new("event\n2").expect_err("control character"),
        "eventId",
        ModelErrorKind::ControlCharacter,
    );
    assert_model_error(
        TaskContractSchemaVersion::new("v".repeat(65)).expect_err("long schema version"),
        "schemaVersion",
        ModelErrorKind::TooLong,
    );
    assert_model_error(
        ContractHash::new("sha256:NOT-CANONICAL").expect_err("invalid contract hash"),
        "contractHash",
        ModelErrorKind::InvalidHash,
    );
    assert_model_error(
        LeaseEpoch::new(0).expect_err("zero lease epoch"),
        "leaseEpoch",
        ModelErrorKind::OutOfRange,
    );
    assert_model_error(
        AttemptOrdinal::new(0).expect_err("zero attempt ordinal"),
        "attemptOrdinal",
        ModelErrorKind::OutOfRange,
    );
    assert_model_error(
        UnixTimestamp::new(-1).expect_err("negative timestamp"),
        "timestamp",
        ModelErrorKind::OutOfRange,
    );
}

#[test]
fn unknown_authority_strategy_and_status_values_fail_closed() {
    assert!(serde_json::from_str::<TaskAuthority>("\"thirdParty\"").is_err());
    assert!(serde_json::from_str::<StrategyKind>("\"workflow\"").is_err());
    assert!(serde_json::from_str::<TaskStatus>("\"unknown\"").is_err());
}

#[test]
fn lease_contains_only_hash_epoch_and_expiry() {
    let lease = LeaseGrant::new(
        LeaseEpoch::new(2).expect("lease epoch"),
        FencingTokenHash::new(HASH_A).expect("token hash"),
        UnixTimestamp::new(1_800_000_000).expect("expiry"),
    );

    assert_eq!(
        lease,
        LeaseGrant {
            epoch: LeaseEpoch::new(2).expect("lease epoch"),
            fencing_token_hash: FencingTokenHash::new(HASH_A).expect("token hash"),
            expires_at: UnixTimestamp::new(1_800_000_000).expect("expiry"),
        }
    );
    assert_eq!(
        serde_json::to_value(&lease).expect("serialize lease"),
        serde_json::json!({
            "epoch": 2,
            "fencingTokenHash": HASH_A,
            "expiresAt": 1_800_000_000_i64,
        })
    );
}

fn contract_spec(
    bindings: Vec<crewon_resource_federation::ResolvedResourceBinding>,
) -> TaskContractSpec {
    TaskContractSpec {
        task_id: TaskId::new("task-1").expect("task id"),
        authority: TaskAuthority::LocalAppServer,
        strategy: StrategyKind::Office,
        workspace_key: WorkspaceKey::new("workspace-1").expect("workspace key"),
        schema_version: TaskContractSchemaVersion::new(TASK_CONTRACT_SCHEMA_VERSION)
            .expect("schema version"),
        execution_spec: ExecutionSpecRef::new(
            ExecutionSpecId::new("execution-spec-1").expect("execution spec id"),
            ExecutionSpecRevision::new(1).expect("execution spec revision"),
            ExecutionSpecDigest::new(HASH_A).expect("execution spec digest"),
        ),
        bindings,
        created_at: UnixTimestamp::new(1_700_000_000).expect("created at"),
    }
}

fn resolved_binding() -> crewon_resource_federation::ResolvedResourceBinding {
    resolved_binding_named("binding-1", "agent-1")
}

fn resolved_binding_named(
    binding_id: &str,
    resource_id: &str,
) -> crewon_resource_federation::ResolvedResourceBinding {
    let provider = ProviderRef {
        provider_id: ProviderId::new("agent-platform").expect("provider id"),
        protocol_version: ProviderProtocolVersion::new("2026-07-01").expect("protocol version"),
    };
    let resource = ResourceRef {
        provider: provider.clone(),
        kind: ResourceKind::Agent,
        resource_id: ResourceId::new(resource_id).expect("resource id"),
        revision: ResourceRevision::new("rev-1").expect("revision"),
    };
    let capability = Capability {
        resource_kind: ResourceKind::Agent,
        binding_mode: BindingMode::RemoteReference,
        execution_location: ExecutionLocation::Provider,
    };
    let manifest = ResourceManifest {
        resource: resource.clone(),
        schema_version: ManifestSchemaVersion::new("1").expect("manifest version"),
        content_digest: Some(ContentDigest::new(HASH_A).expect("content digest")),
    };
    let request = BindingRequest {
        binding_id: BindingId::new(binding_id).expect("binding id"),
        workspace_key: WorkspaceKey::new("workspace-1").expect("workspace key"),
        resource,
        mode: BindingMode::RemoteReference,
        execution_location: ExecutionLocation::Provider,
        materialization: None,
    };
    let capabilities = ProviderCapabilities::new(provider, [capability]).expect("capabilities");

    resolve_binding(&request, &manifest, &capabilities).expect("resolved binding")
}

fn assert_model_error(error: ModelError, field: &'static str, kind: ModelErrorKind) {
    assert_eq!((error.field(), error.kind()), (field, kind));
}
