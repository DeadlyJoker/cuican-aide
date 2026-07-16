use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::TempDir;

use super::*;

#[tokio::test]
async fn failed_record_commit_removes_pending_runtime_owner_claim() {
    let temp_dir = TempDir::new().expect("tempdir");
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let mut config = json!({
        "title": "Repair transaction Office",
        "workspace": {
            "members": [{
                "name": "Engineer",
                "agentId": "agent-a",
                "threadId": "missing-thread",
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

    let error = apply_server_mutation_with_writer(
        &cwd,
        OfficeRuntimeRepairMutation {
            file_path: &file_path,
            source_thread_id: "missing-thread",
            replacement_thread_id: "replacement-thread",
            agent_id: "agent-a",
        },
        |config| {
            config["workspace"]["members"][0]["threadId"] = json!("replacement-thread");
            config["workspace"]["members"][0]["runtime"] = json!({
                "threadId": "replacement-thread",
                "sessionScope": "office",
                "runtimeVersion": 2,
                "repairSourceThreadId": "missing-thread",
                "repairedAt": "2026-07-13T00:00:00Z",
                "agentProfileSource": "officeMemberRepair"
            });
            Ok(OfficeRuntimeMutation::BindReplacement { member_id: None })
        },
        |_, _, _| async { Err(internal_error("injected Office record write failure")) },
    )
    .await
    .expect_err("record write must fail");
    assert_eq!(error.message, "injected Office record write failure");

    let persisted = office_storage::read_office_record_strict(std::path::Path::new(&file_path))
        .await
        .expect("read Office record")
        .expect("Office record exists");
    assert_eq!(
        persisted.config["workspace"]["members"][0]["runtime"]["threadId"],
        "missing-thread"
    );

    let authority = office_authority_lock::lock(&cwd)
        .await
        .expect("acquire authority");
    let registry = office_runtime_owner_registry::load(&cwd, &authority)
        .await
        .expect("load runtime owners");
    let stolen = json!({
        "workspace": {
            "recordId": "record-b",
            "members": [{
                "agentId": "agent-b",
                "runtime": { "threadId": "replacement-thread" }
            }]
        }
    });
    registry
        .validate_config(&stolen)
        .expect("failed repair must release its pending claim");
}
