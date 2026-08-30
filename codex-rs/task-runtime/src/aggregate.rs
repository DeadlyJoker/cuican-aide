use crate::AggregateVersion;
use crate::AttemptId;
use crate::AttemptOrdinal;
use crate::AttemptStatus;
use crate::ContractHash;
use crate::EventId;
use crate::ExecutionSpecRef;
use crate::IdempotencyKey;
use crate::LeaseGrant;
use crate::ModelError;
use crate::ProducerSequence;
use crate::StrategyKind;
use crate::SuspensionReason;
use crate::TaskAuthority;
use crate::TaskContractSchemaVersion;
use crate::TaskId;
use crate::TaskStatus;
use crate::TaskStreamOffset;
use crate::UnixTimestamp;
use crate::WorkerRunId;
use crewon_resource_federation::ResolvedResourceBinding;
use crewon_resource_federation::WorkspaceKey;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeSet;

/// Maximum number of immutable resource bindings in one Task Contract.
pub const MAX_TASK_BINDINGS: usize = 32;

/// Maximum number of Authority-created Attempts retained by one Task.
pub const MAX_TASK_ATTEMPTS: usize = 16;

/// Only Task Contract schema understood by this first durable execution composition.
pub const TASK_CONTRACT_SCHEMA_VERSION: &str = "2";

/// Validated input used to create an immutable Task Contract.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskContractSpec {
    pub task_id: TaskId,
    pub authority: TaskAuthority,
    pub strategy: StrategyKind,
    pub workspace_key: WorkspaceKey,
    pub schema_version: TaskContractSchemaVersion,
    pub execution_spec: ExecutionSpecRef,
    pub bindings: Vec<ResolvedResourceBinding>,
    pub created_at: UnixTimestamp,
}

/// Immutable execution contract owned by one Task Authority.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskContract {
    task_id: TaskId,
    authority: TaskAuthority,
    strategy: StrategyKind,
    workspace_key: WorkspaceKey,
    schema_version: TaskContractSchemaVersion,
    contract_hash: ContractHash,
    execution_spec: ExecutionSpecRef,
    bindings: Vec<ResolvedResourceBinding>,
    created_at: UnixTimestamp,
}

impl TaskContract {
    /// Constructs a bounded immutable Task Contract.
    pub fn new(mut spec: TaskContractSpec) -> Result<Self, ModelError> {
        if spec.schema_version.as_str() != TASK_CONTRACT_SCHEMA_VERSION {
            return Err(ModelError::new(
                "schemaVersion",
                crate::ModelErrorKind::Mismatch,
            ));
        }
        if spec.bindings.len() > MAX_TASK_BINDINGS {
            return Err(ModelError::too_many_items("bindings"));
        }
        spec.bindings
            .sort_by(|left, right| left.binding_id().as_str().cmp(right.binding_id().as_str()));
        let mut binding_ids = BTreeSet::new();
        for binding in &spec.bindings {
            if binding.workspace_key() != &spec.workspace_key {
                return Err(ModelError::new(
                    "bindingWorkspaceKey",
                    crate::ModelErrorKind::Mismatch,
                ));
            }
            if !binding_ids.insert(binding.binding_id()) {
                return Err(ModelError::new(
                    "bindingId",
                    crate::ModelErrorKind::Duplicate,
                ));
            }
        }
        let contract_hash = calculate_contract_hash(&spec)?;
        Ok(Self {
            task_id: spec.task_id,
            authority: spec.authority,
            strategy: spec.strategy,
            workspace_key: spec.workspace_key,
            schema_version: spec.schema_version,
            contract_hash,
            execution_spec: spec.execution_spec,
            bindings: spec.bindings,
            created_at: spec.created_at,
        })
    }

    /// Returns the stable Task identifier.
    pub fn task_id(&self) -> &TaskId {
        &self.task_id
    }

    /// Returns the immutable Authority that owns all state decisions.
    pub fn authority(&self) -> TaskAuthority {
        self.authority
    }

    /// Returns the closed execution strategy.
    pub fn strategy(&self) -> StrategyKind {
        self.strategy
    }

    /// Returns the workspace registry key used by every Worker.
    pub fn workspace_key(&self) -> &WorkspaceKey {
        &self.workspace_key
    }

    /// Returns the Task Contract schema version.
    pub fn schema_version(&self) -> &TaskContractSchemaVersion {
        &self.schema_version
    }

    /// Returns the canonical hash of the immutable Contract.
    pub fn contract_hash(&self) -> &ContractHash {
        &self.contract_hash
    }

    /// Returns the exact immutable execution input reference.
    pub fn execution_spec(&self) -> &ExecutionSpecRef {
        &self.execution_spec
    }

    /// Returns the bounded, exact resource binding snapshot.
    pub fn bindings(&self) -> &[ResolvedResourceBinding] {
        &self.bindings
    }

    /// Returns when this Contract was created by its Authority.
    pub fn created_at(&self) -> UnixTimestamp {
        self.created_at
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskContractHashInput<'a> {
    task_id: &'a TaskId,
    authority: TaskAuthority,
    strategy: StrategyKind,
    workspace_key: &'a WorkspaceKey,
    schema_version: &'a TaskContractSchemaVersion,
    execution_spec: &'a ExecutionSpecRef,
    bindings: Vec<crewon_resource_federation::ResolvedResourceBindingSnapshot>,
    created_at: UnixTimestamp,
}

fn calculate_contract_hash(spec: &TaskContractSpec) -> Result<ContractHash, ModelError> {
    let input = TaskContractHashInput {
        task_id: &spec.task_id,
        authority: spec.authority,
        strategy: spec.strategy,
        workspace_key: &spec.workspace_key,
        schema_version: &spec.schema_version,
        execution_spec: &spec.execution_spec,
        bindings: spec
            .bindings
            .iter()
            .map(ResolvedResourceBinding::to_snapshot)
            .collect(),
        created_at: spec.created_at,
    };
    let canonical = serde_json::to_vec(&input)
        .map_err(|_| ModelError::new("contractHash", crate::ModelErrorKind::InvalidHash))?;
    let digest = Sha256::digest(canonical);
    ContractHash::new(format!("sha256:{digest:x}"))
}

/// One Authority-created execution Attempt; Executors cannot construct these.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attempt {
    pub(crate) attempt_id: AttemptId,
    pub(crate) ordinal: AttemptOrdinal,
    pub(crate) idempotency_key: IdempotencyKey,
    pub(crate) status: AttemptStatus,
    pub(crate) worker_run_id: Option<WorkerRunId>,
    pub(crate) lease: Option<LeaseGrant>,
    pub(crate) last_producer_sequence: Option<ProducerSequence>,
}

impl Attempt {
    pub(crate) fn created(
        attempt_id: AttemptId,
        ordinal: AttemptOrdinal,
        idempotency_key: IdempotencyKey,
    ) -> Self {
        Self {
            attempt_id,
            ordinal,
            idempotency_key,
            status: AttemptStatus::Created,
            worker_run_id: None,
            lease: None,
            last_producer_sequence: None,
        }
    }

    /// Returns the stable Attempt identifier.
    pub fn attempt_id(&self) -> &AttemptId {
        &self.attempt_id
    }

    /// Returns the one-based Authority ordinal.
    pub fn ordinal(&self) -> AttemptOrdinal {
        self.ordinal
    }

    /// Returns the idempotency key shared with the Worker executor.
    pub fn idempotency_key(&self) -> &IdempotencyKey {
        &self.idempotency_key
    }

    /// Returns the Attempt lifecycle state.
    pub fn status(&self) -> AttemptStatus {
        self.status
    }

    /// Returns the currently claimed Worker run, if any.
    pub fn worker_run_id(&self) -> Option<&WorkerRunId> {
        self.worker_run_id.as_ref()
    }

    /// Returns the current lease evidence, if claimed.
    pub fn lease(&self) -> Option<&LeaseGrant> {
        self.lease.as_ref()
    }

    /// Returns the last accepted sequence for the current Worker run.
    pub fn last_producer_sequence(&self) -> Option<ProducerSequence> {
        self.last_producer_sequence
    }
}

/// Reducer-owned snapshot of a durable Task and all of its Attempts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskAggregate {
    pub(crate) contract: TaskContract,
    pub(crate) status: TaskStatus,
    pub(crate) suspension_reason: Option<SuspensionReason>,
    pub(crate) attempts: Vec<Attempt>,
    pub(crate) active_attempt_id: Option<AttemptId>,
    pub(crate) aggregate_version: AggregateVersion,
    pub(crate) task_stream_offset: TaskStreamOffset,
    pub(crate) last_event_id: Option<EventId>,
    pub(crate) progress_count: u64,
}

impl TaskAggregate {
    /// Creates the deterministic version-zero snapshot for a validated Contract.
    pub fn new(contract: TaskContract) -> Self {
        Self {
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
    }

    /// Returns the immutable Task Contract.
    pub fn contract(&self) -> &TaskContract {
        &self.contract
    }

    /// Returns the current Task lifecycle state.
    pub fn status(&self) -> TaskStatus {
        self.status
    }

    /// Returns why an active Task is suspended.
    pub fn suspension_reason(&self) -> Option<SuspensionReason> {
        self.suspension_reason
    }

    /// Returns every bounded Authority-created Attempt in ordinal order.
    pub fn attempts(&self) -> &[Attempt] {
        &self.attempts
    }

    /// Returns the currently active Attempt, if any.
    pub fn active_attempt(&self) -> Option<&Attempt> {
        let active_id = self.active_attempt_id.as_ref()?;
        self.attempts
            .iter()
            .find(|attempt| &attempt.attempt_id == active_id)
    }

    /// Returns the optimistic-concurrency Aggregate version.
    pub fn aggregate_version(&self) -> AggregateVersion {
        self.aggregate_version
    }

    /// Returns the last committed Task stream cursor.
    pub fn task_stream_offset(&self) -> TaskStreamOffset {
        self.task_stream_offset
    }

    /// Returns the last committed Event identifier.
    pub fn last_event_id(&self) -> Option<&EventId> {
        self.last_event_id.as_ref()
    }

    /// Returns how many bounded progress facts the Reducer accepted.
    pub fn progress_count(&self) -> u64 {
        self.progress_count
    }
}
