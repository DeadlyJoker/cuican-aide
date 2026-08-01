use pretty_assertions::assert_eq;

use crate::ExecutionSpecDigest;
use crate::ExecutionSpecId;
use crate::ExecutionSpecRef;
use crate::ExecutionSpecRevision;
use crate::ModelErrorKind;
use crate::StrategyKind;
use crate::TaskAuthority;
use crate::TaskContract;
use crate::TaskContractSchemaVersion;
use crate::TaskContractSpec;
use crate::TaskId;
use crate::TaskSnapshotError;
use crate::UnixTimestamp;
use crewon_resource_federation::WorkspaceKey;

const HASH_A: &str = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CONTRACT_HASH: &str =
    "sha256:e9a8a1375b6b4bf1020a6e9d4c0000560390671c164878b5cb304e0047322ae8";

#[test]
fn execution_spec_ref_is_bounded_and_secret_free() {
    let reference = execution_spec("execution-spec-1", 1, HASH_A);

    assert_eq!(
        serde_json::to_value(&reference).expect("serialize execution spec ref"),
        serde_json::json!({
            "executionSpecId": "execution-spec-1",
            "revision": 1,
            "digest": HASH_A,
        })
    );
    assert_eq!(
        ExecutionSpecRevision::new(0)
            .expect_err("zero revision")
            .kind(),
        ModelErrorKind::OutOfRange
    );
    assert_eq!(
        ExecutionSpecDigest::new("not-a-digest")
            .expect_err("invalid digest")
            .kind(),
        ModelErrorKind::InvalidHash
    );
}

#[test]
fn task_contract_hash_binds_the_execution_spec() {
    let first = TaskContract::new(contract_spec(execution_spec("execution-spec-1", 1, HASH_A)))
        .expect("first contract");
    let second = TaskContract::new(contract_spec(execution_spec("execution-spec-2", 1, HASH_A)))
        .expect("second contract");

    assert_eq!(first.contract_hash().as_str(), CONTRACT_HASH);
    assert_ne!(first.contract_hash(), second.contract_hash());
}

#[test]
fn snapshot_restore_rejects_execution_spec_tampering() {
    let contract = TaskContract::new(contract_spec(execution_spec("execution-spec-1", 1, HASH_A)))
        .expect("contract");
    let mut snapshot = contract.to_snapshot();
    snapshot.execution_spec = execution_spec("execution-spec-2", 2, HASH_B);

    assert_eq!(
        TaskContract::restore(snapshot),
        Err(TaskSnapshotError::ContractHashMismatch)
    );
}

fn contract_spec(execution_spec: ExecutionSpecRef) -> TaskContractSpec {
    TaskContractSpec {
        task_id: TaskId::new("task-1").expect("task id"),
        authority: TaskAuthority::LocalAppServer,
        strategy: StrategyKind::Single,
        workspace_key: WorkspaceKey::new("workspace-1").expect("workspace key"),
        schema_version: TaskContractSchemaVersion::new("2").expect("schema version"),
        execution_spec,
        bindings: Vec::new(),
        created_at: UnixTimestamp::new(1).expect("created at"),
    }
}

fn execution_spec(id: &str, revision: u64, digest: &str) -> ExecutionSpecRef {
    ExecutionSpecRef::new(
        ExecutionSpecId::new(id).expect("execution spec id"),
        ExecutionSpecRevision::new(revision).expect("execution spec revision"),
        ExecutionSpecDigest::new(digest).expect("execution spec digest"),
    )
}
