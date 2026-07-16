use serde_json::json;
use tempfile::TempDir;

use super::*;

#[tokio::test]
async fn reconciliation_promotes_committed_claim_and_removes_orphan_claim() {
    let temp_dir = TempDir::new().expect("tempdir");
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let mut config = json!({
        "title": "Runtime reconciliation Office",
        "workspace": {
            "members": [{
                "agentId": "agent-a",
                "runtime": { "threadId": "missing-thread" }
            }],
            "messages": []
        }
    });
    let file_path = office_storage::save_office_record(
        &cwd,
        &mut config,
        super::super::office_workspace_identity::OfficeWriteIntent::Create,
    )
    .await
    .expect("seed Office record");

    let authority = super::super::office_authority_lock::lock(&cwd)
        .await
        .expect("acquire authority");
    let mut registry = office_runtime_owner_registry::load(&cwd, &authority)
        .await
        .expect("load registry");
    let member_id = config["workspace"]["members"][0]["memberId"]
        .as_str()
        .expect("server-owned memberId");
    registry
        .claim_member_pending(
            "committed-runtime",
            config["workspace"]["recordId"].as_str().expect("record id"),
            Some(member_id),
            "agent-a",
            "missing-thread",
        )
        .await
        .expect("claim committed runtime");
    registry
        .claim_member_pending(
            "orphan-runtime",
            config["workspace"]["recordId"].as_str().expect("record id"),
            Some(member_id),
            "agent-a",
            "other-missing-thread",
        )
        .await
        .expect("claim orphan runtime");
    config["workspace"]["members"][0]["threadId"] = json!("committed-runtime");
    config["workspace"]["members"][0]["runtime"] = json!({
        "threadId": "committed-runtime",
        "sessionScope": "office",
        "runtimeVersion": 2,
        "repairSourceThreadId": "missing-thread",
        "repairedAt": "2026-07-13T00:00:00Z",
        "agentProfileSource": "officeMemberRepair"
    });
    super::super::write_domain_record(
        super::super::DomainKind::Office,
        std::path::Path::new(&file_path),
        "2026-07-13T00:00:00.000Z".to_string(),
        config.clone(),
    )
    .await
    .expect("commit Office record without activating claim");
    drop(registry);
    drop(authority);

    let directory = super::super::domain_directory(&cwd, super::super::DomainKind::Office)
        .expect("Office directory");
    let authority = super::super::office_authority_lock::lock(&cwd)
        .await
        .expect("reacquire authority");
    let mut registry = office_runtime_owner_registry::load(&cwd, &authority)
        .await
        .expect("reload registry");
    reconcile_if_needed(&directory, &mut registry)
        .await
        .expect("reconcile pending claims");

    registry
        .validate_config(&config)
        .expect("committed claim remains owned by its member");
    let other_record = |runtime_thread_id| {
        json!({
            "workspace": {
                "recordId": "record-b",
                "members": [{
                    "agentId": "agent-b",
                    "runtime": { "threadId": runtime_thread_id }
                }]
            }
        })
    };
    assert!(
        registry
            .validate_config(&other_record("committed-runtime"))
            .is_err()
    );
    registry
        .validate_config(&other_record("orphan-runtime"))
        .expect("orphan pending claim is removed");
}
