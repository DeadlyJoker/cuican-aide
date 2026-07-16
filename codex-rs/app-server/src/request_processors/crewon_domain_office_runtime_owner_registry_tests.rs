use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::TempDir;

use super::*;

#[tokio::test]
async fn registered_runtime_cannot_cross_record_or_agent_ownership() {
    let temp_dir = TempDir::new().expect("tempdir");
    let cwd = temp_dir.path().to_string_lossy();
    let authority = office_authority_lock::lock(&cwd)
        .await
        .expect("acquire authority");
    let mut registry = load(&cwd, &authority).await.expect("load registry");
    let claim = registry
        .claim_pending(
            "replacement-thread",
            "record-a",
            "agent-a",
            "missing-thread",
        )
        .await
        .expect("claim runtime");
    registry.activate(&claim).await.expect("activate runtime");

    let other_record = office_config("record-b", "agent-b", "replacement-thread");
    let error = registry
        .validate_config(&other_record)
        .expect_err("cross-record runtime use must fail");
    assert!(
        error
            .message
            .contains("owned by record record-a agent agent-a")
    );

    let other_agent = office_config("record-a", "agent-b", "replacement-thread");
    let error = registry
        .validate_config(&other_agent)
        .expect_err("cross-agent runtime use must fail");
    assert!(
        error
            .message
            .contains("record record-a agent agent-b cannot use it")
    );
}

#[tokio::test]
async fn registered_runtime_cannot_cross_member_identity_with_same_agent() {
    let temp_dir = TempDir::new().expect("tempdir");
    let cwd = temp_dir.path().to_string_lossy();
    let authority = office_authority_lock::lock(&cwd)
        .await
        .expect("acquire authority");
    let mut registry = load(&cwd, &authority).await.expect("load registry");
    let claim = registry
        .claim_member_pending(
            "replacement-thread",
            "record-a",
            Some("member-a"),
            "agent-a",
            "member-add-source",
        )
        .await
        .expect("claim exact member runtime");
    registry.activate(&claim).await.expect("activate runtime");

    let exact_owner =
        office_config_with_member_id("record-a", "member-a", "agent-a", "replacement-thread");
    registry
        .validate_config(&exact_owner)
        .expect("exact member owner must retain its runtime");
    let rebound_member =
        office_config_with_member_id("record-a", "member-b", "agent-a", "replacement-thread");
    let error = registry
        .validate_config(&rebound_member)
        .expect_err("same Agent cannot transfer a runtime across memberId");
    assert!(error.message.contains("cannot use it"));
}

#[tokio::test]
async fn deleting_owner_member_does_not_release_runtime_for_transfer() {
    let temp_dir = TempDir::new().expect("tempdir");
    let cwd = temp_dir.path().to_string_lossy();
    let authority = office_authority_lock::lock(&cwd)
        .await
        .expect("acquire authority");
    let mut registry = load(&cwd, &authority).await.expect("load registry");
    let claim = registry
        .claim_pending(
            "replacement-thread",
            "record-a",
            "agent-a",
            "missing-thread",
        )
        .await
        .expect("claim runtime");
    registry.activate(&claim).await.expect("activate runtime");

    let removed = json!({
        "workspace": {
            "recordId": "record-a",
            "members": []
        }
    });
    registry
        .validate_config(&removed)
        .expect("removing the member does not transfer the owner");

    let transferred = office_config("record-a", "agent-b", "replacement-thread");
    assert!(registry.validate_config(&transferred).is_err());
}

#[tokio::test]
async fn failed_repair_can_remove_its_pending_claim() {
    let temp_dir = TempDir::new().expect("tempdir");
    let cwd = temp_dir.path().to_string_lossy();
    let authority = office_authority_lock::lock(&cwd)
        .await
        .expect("acquire authority");
    let mut registry = load(&cwd, &authority).await.expect("load registry");
    let claim = registry
        .claim_pending(
            "replacement-thread",
            "record-a",
            "agent-a",
            "missing-thread",
        )
        .await
        .expect("claim runtime");
    registry
        .remove_pending(&claim)
        .await
        .expect("remove pending claim");
    drop(registry);
    drop(authority);

    let authority = office_authority_lock::lock(&cwd)
        .await
        .expect("reacquire authority");
    let registry = load(&cwd, &authority).await.expect("reload registry");
    let other_record = office_config("record-b", "agent-b", "replacement-thread");
    registry
        .validate_config(&other_record)
        .expect("removed pending claim must not reserve the runtime");
    assert_eq!(registry.registry.entries, BTreeMap::new());
}

#[tokio::test]
async fn automation_pending_owner_survives_member_reconciliation() {
    let temp_dir = TempDir::new().expect("tempdir");
    let cwd = temp_dir.path().to_string_lossy();
    let authority = office_authority_lock::lock(&cwd)
        .await
        .expect("acquire authority");
    let mut registry = load(&cwd, &authority).await.expect("load registry");
    let claim = registry
        .claim_automation_pending(
            "automation-runtime",
            "/workspace/.crewon/automations/nightly.json",
            "missing-runtime",
        )
        .await
        .expect("claim automation runtime");
    assert!(
        registry
            .claim_automation_pending(
                "automation-runtime",
                "/workspace/.crewon/automations/other.json",
                "missing-runtime",
            )
            .await
            .is_err(),
        "another Automation record cannot reuse the runtime owner"
    );
    registry
        .reconcile_persisted_configs(
            std::iter::empty(),
            OfficeRuntimeOwnerReconciliation::Complete,
        )
        .await
        .expect("reconcile member owners");
    assert!(registry.owns_runtime_thread("automation-runtime"));
    assert!(registry.owns_automation_runtime(
        "automation-runtime",
        "/workspace/.crewon/automations/nightly.json",
        "missing-runtime",
    ));
    assert!(!registry.owns_automation_runtime(
        "automation-runtime",
        "/workspace/.crewon/automations/other.json",
        "missing-runtime",
    ));
    assert!(!registry.owns_automation_runtime(
        "automation-runtime",
        "/workspace/.crewon/automations/nightly.json",
        "different-source-runtime",
    ));
    let member_claim = registry
        .claim_pending(
            "member-runtime",
            "office-record",
            "member-agent",
            "missing-member-runtime",
        )
        .await
        .expect("claim member runtime");
    registry
        .activate(&member_claim)
        .await
        .expect("activate member runtime");
    assert!(!registry.owns_automation_runtime(
        "member-runtime",
        "/workspace/.crewon/automations/nightly.json",
        "missing-member-runtime",
    ));
    registry
        .activate(&claim)
        .await
        .expect("activate automation runtime");
    drop(registry);
    drop(authority);

    let authority = office_authority_lock::lock(&cwd)
        .await
        .expect("reacquire authority");
    let registry = load(&cwd, &authority).await.expect("reload registry");
    assert!(registry.owns_runtime_thread("automation-runtime"));
}

fn office_config(record_id: &str, agent_id: &str, runtime_thread_id: &str) -> JsonValue {
    json!({
        "workspace": {
            "recordId": record_id,
            "members": [{
                "name": "Member",
                "agentId": agent_id,
                "threadId": runtime_thread_id,
                "runtime": {
                    "threadId": runtime_thread_id
                }
            }],
            "activity": {
                "runs": [{
                    "delegationRoutes": [{
                        "member": "Member",
                        "agentId": agent_id,
                        "targetKind": "runtimeThread",
                        "threadId": runtime_thread_id,
                        "target": runtime_thread_id
                    }],
                    "delegations": [{
                        "member": "Member",
                        "agentId": agent_id,
                        "threadId": runtime_thread_id
                    }]
                }]
            }
        }
    })
}

fn office_config_with_member_id(
    record_id: &str,
    member_id: &str,
    agent_id: &str,
    runtime_thread_id: &str,
) -> JsonValue {
    let mut config = office_config(record_id, agent_id, runtime_thread_id);
    config["workspace"]["members"][0]["memberId"] = json!(member_id);
    config["workspace"]["activity"]["runs"][0]["delegationRoutes"][0]["memberId"] =
        json!(member_id);
    config["workspace"]["activity"]["runs"][0]["delegations"][0]["memberId"] = json!(member_id);
    config
}
