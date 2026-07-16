use std::time::Duration;

use anyhow::Result;
use app_test_support::TestAppServer;
use app_test_support::to_response;
use crewon_app_server_protocol::AutomationSaveResponse;
use crewon_app_server_protocol::JSONRPCError;
use crewon_app_server_protocol::JSONRPCResponse;
use crewon_app_server_protocol::OfficeAutomationBindingDeleteResponse;
use crewon_app_server_protocol::OfficeAutomationBindingUpsertResponse;
use crewon_app_server_protocol::OfficeCreateResponse;
use crewon_app_server_protocol::OfficeManagerEnsureResponse;
use crewon_app_server_protocol::OfficeSaveResponse;
use crewon_app_server_protocol::RequestId;
use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::TempDir;
use tokio::time::timeout;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

async fn initialized_app_server(codex_home: &TempDir) -> Result<TestAppServer> {
    let mut mcp = TestAppServer::new(codex_home.path()).await?;
    timeout(DEFAULT_TIMEOUT, mcp.initialize()).await??;
    Ok(mcp)
}

async fn request<T: serde::de::DeserializeOwned>(
    mcp: &mut TestAppServer,
    method: &str,
    params: serde_json::Value,
) -> Result<T> {
    let request_id = mcp.send_raw_request(method, Some(params)).await?;
    let response: JSONRPCResponse = timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_response_message(RequestId::Integer(request_id)),
    )
    .await??;
    to_response(response)
}

async fn request_error(
    mcp: &mut TestAppServer,
    method: &str,
    params: serde_json::Value,
) -> Result<JSONRPCError> {
    let request_id = mcp.send_raw_request(method, Some(params)).await?;
    timeout(
        DEFAULT_TIMEOUT,
        mcp.read_stream_until_error_message(RequestId::Integer(request_id)),
    )
    .await?
}

fn policy(
    dispatch_mode: &str,
    risk_level: &str,
    approval_mode: &str,
    status: &str,
) -> serde_json::Value {
    json!({
        "dispatchMode": dispatch_mode,
        "riskLevel": risk_level,
        "approvalMode": approval_mode,
        "status": status,
    })
}

#[tokio::test]
async fn office_automation_binding_is_cas_guarded_and_preserved_by_ordinary_save() -> Result<()> {
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    let cwd = workspace.path().to_string_lossy().into_owned();
    let mut mcp = initialized_app_server(&codex_home).await?;

    let automation: AutomationSaveResponse = request(
        &mut mcp,
        "automation/save",
        json!({
            "cwd": cwd,
            "config": {
                "title": "Nightly QA",
                "threadId": "automation-thread-binding-test",
                "prompt": "Run bound verification"
            }
        }),
    )
    .await?;
    let created: OfficeCreateResponse = request(
        &mut mcp,
        "office/create",
        json!({
            "cwd": cwd,
            "title": "Platform Office",
            "subtitle": null,
            "threadId": null,
            "goal": "Ship safely"
        }),
    )
    .await?;
    let office: OfficeManagerEnsureResponse = request(
        &mut mcp,
        "office/manager/ensure",
        json!({
            "cwd": cwd,
            "officeRecordId": created.config["workspace"]["recordId"],
            "expectedRecordRevision": created.config["workspace"]["recordRevision"]
        }),
    )
    .await?;
    let original_revision = office.config["workspace"]["recordRevision"]
        .as_str()
        .expect("record revision")
        .to_string();
    let upserted: OfficeAutomationBindingUpsertResponse = request(
        &mut mcp,
        "office/automation/binding/upsert",
        json!({
            "cwd": cwd,
            "officeRecordId": office.config["workspace"]["recordId"],
            "expectedRecordRevision": original_revision,
            "bindingId": "nightly-qa",
            "automationFilePath": automation.file_path,
            "policy": policy("manual", "high", "required", "enabled")
        }),
    )
    .await?;
    assert_eq!(upserted.binding.binding_id, "nightly-qa");
    assert_eq!(
        upserted.config["workspace"]["automationBindings"][0]["automationFilePath"],
        automation.file_path
    );

    let stale_error = request_error(
        &mut mcp,
        "office/automation/binding/upsert",
        json!({
            "cwd": cwd,
            "officeRecordId": upserted.config["workspace"]["recordId"],
            "expectedRecordRevision": original_revision,
            "bindingId": "nightly-qa",
            "automationFilePath": automation.file_path,
            "policy": policy("auto", "low", "notRequired", "enabled")
        }),
    )
    .await?;
    assert!(stale_error.error.message.contains("is stale"));

    let mut omitted = upserted.config.clone();
    omitted["workspace"]
        .as_object_mut()
        .expect("workspace object")
        .remove("automationBindings");
    omitted["workspace"]["goal"] = json!("Ship safely with preserved authority");
    let preserved: OfficeSaveResponse = request(
        &mut mcp,
        "office/save",
        json!({"cwd": cwd, "config": omitted}),
    )
    .await?;
    assert_eq!(
        preserved.config["workspace"]["automationBindings"],
        upserted.config["workspace"]["automationBindings"]
    );

    let mut forged = preserved.config.clone();
    forged["workspace"]["automationBindings"][0]["policy"] =
        policy("auto", "low", "notRequired", "enabled");
    let forged_error = request_error(
        &mut mcp,
        "office/save",
        json!({"cwd": cwd, "config": forged}),
    )
    .await?;
    assert!(forged_error.error.message.contains("server-owned"));

    let deleted: OfficeAutomationBindingDeleteResponse = request(
        &mut mcp,
        "office/automation/binding/delete",
        json!({
            "cwd": cwd,
            "officeRecordId": preserved.config["workspace"]["recordId"],
            "expectedRecordRevision": preserved.config["workspace"]["recordRevision"],
            "bindingId": "nightly-qa"
        }),
    )
    .await?;
    assert!(deleted.deleted);
    assert_eq!(deleted.binding_id, "nightly-qa");
    assert_eq!(deleted.config["workspace"]["automationBindings"], json!([]));
    Ok(())
}

#[tokio::test]
async fn office_automation_binding_rejects_non_automation_paths() -> Result<()> {
    let codex_home = TempDir::new()?;
    let workspace = TempDir::new()?;
    let cwd = workspace.path().to_string_lossy().into_owned();
    let mut mcp = initialized_app_server(&codex_home).await?;
    let created: OfficeCreateResponse = request(
        &mut mcp,
        "office/create",
        json!({
            "cwd": cwd,
            "title": "Platform Office",
            "subtitle": null,
            "threadId": null,
            "goal": "Validate automation paths"
        }),
    )
    .await?;
    let office: OfficeManagerEnsureResponse = request(
        &mut mcp,
        "office/manager/ensure",
        json!({
            "cwd": cwd,
            "officeRecordId": created.config["workspace"]["recordId"],
            "expectedRecordRevision": created.config["workspace"]["recordRevision"]
        }),
    )
    .await?;
    let outside_path = workspace.path().join("not-an-automation.json");
    std::fs::write(&outside_path, "{}")?;

    let error = request_error(
        &mut mcp,
        "office/automation/binding/upsert",
        json!({
            "cwd": cwd,
            "officeRecordId": office.config["workspace"]["recordId"],
            "expectedRecordRevision": office.config["workspace"]["recordRevision"],
            "bindingId": "outside",
            "automationFilePath": outside_path,
            "policy": policy("manual", "low", "notRequired", "enabled")
        }),
    )
    .await?;
    assert!(error.error.message.contains("must be inside"));

    #[cfg(unix)]
    {
        let automation: AutomationSaveResponse = request(
            &mut mcp,
            "automation/save",
            json!({
                "cwd": cwd,
                "config": {
                    "title": "Symlink target",
                    "threadId": "automation-thread-symlink-target",
                    "prompt": "Must be reached through the regular file only"
                }
            }),
        )
        .await?;
        let symlink_path = workspace
            .path()
            .join(".crewon")
            .join("automations")
            .join("symlink.json");
        std::os::unix::fs::symlink(&automation.file_path, &symlink_path)?;
        let symlink_error = request_error(
            &mut mcp,
            "office/automation/binding/upsert",
            json!({
                "cwd": cwd,
                "officeRecordId": office.config["workspace"]["recordId"],
                "expectedRecordRevision": office.config["workspace"]["recordRevision"],
                "bindingId": "symlink",
                "automationFilePath": symlink_path,
                "policy": policy("manual", "low", "notRequired", "enabled")
            }),
        )
        .await?;
        assert!(symlink_error.error.message.contains("non-symlink"));
    }
    Ok(())
}
