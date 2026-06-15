use crewon_app_server_protocol::AgentListParams;
use crewon_app_server_protocol::AgentSaveParams;
use crewon_app_server_protocol::AutomationListParams;
use crewon_app_server_protocol::OfficeSaveParams;
use crewon_app_server_protocol::ToolConfigKind;
use crewon_app_server_protocol::ToolListParams;
use crewon_app_server_protocol::ToolSaveParams;
use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::TempDir;

use super::CrewonDomainRequestProcessor;
use crate::error_code::INVALID_PARAMS_ERROR_CODE;

#[tokio::test]
async fn saves_and_lists_agent_configs() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let config = json!({
        "name": "Demo Agent",
        "threadId": "thread-123456789",
        "role": "Engineer"
    });

    let save_response = processor
        .agent_save(AgentSaveParams {
            cwd: temp_dir.path().to_string_lossy().into_owned(),
            config: config.clone(),
        })
        .await
        .expect("save agent config");

    assert!(
        save_response
            .file_path
            .ends_with(".crewon/agents/demo-agent-thread-1.json"),
        "unexpected file path: {}",
        save_response.file_path
    );

    let list_response = processor
        .agent_list(AgentListParams {
            cwd: temp_dir.path().to_string_lossy().into_owned(),
            cursor: None,
            limit: None,
        })
        .await
        .expect("list agent configs");

    assert_eq!(list_response.data.len(), 1);
    assert_eq!(list_response.data[0].file_path, save_response.file_path);
    assert_eq!(list_response.data[0].config, config);
    assert!(!list_response.data[0].saved_at.is_empty());
}

#[tokio::test]
async fn list_ignores_invalid_or_wrong_kind_records() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let automation_dir = temp_dir.path().join(".crewon").join("automations");
    std::fs::create_dir_all(&automation_dir).expect("create automation dir");
    std::fs::write(automation_dir.join("invalid.json"), "{").expect("write invalid json");
    std::fs::write(
        automation_dir.join("agent.json"),
        serde_json::to_vec(&json!({
            "version": 1,
            "kind": "agent",
            "savedAt": "2026-06-16T00:00:00.000Z",
            "config": { "name": "Wrong kind" }
        }))
        .expect("serialize wrong kind record"),
    )
    .expect("write wrong kind record");

    let processor = CrewonDomainRequestProcessor::new();
    let list_response = processor
        .automation_list(AutomationListParams {
            cwd: temp_dir.path().to_string_lossy().into_owned(),
            cursor: None,
            limit: None,
        })
        .await
        .expect("list automation configs");

    assert_eq!(list_response.data, Vec::new());
}

#[tokio::test]
async fn save_rejects_config_without_required_fields() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();

    let error = processor
        .office_save(OfficeSaveParams {
            cwd: temp_dir.path().to_string_lossy().into_owned(),
            config: json!({ "title": "Missing workspace" }),
        })
        .await
        .expect_err("invalid office config should fail");

    assert_eq!(error.code, INVALID_PARAMS_ERROR_CODE);
    assert_eq!(
        error.message,
        "office config is missing required fields".to_string()
    );
}

#[tokio::test]
async fn saves_and_lists_tool_configs_by_kind() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let mcp_config = json!({
        "kind": "mcp",
        "title": "Issue Tracker",
        "name": "linear"
    });
    let skill_config = json!({
        "kind": "skill",
        "title": "Release Writer",
        "name": "release-writer"
    });

    let mcp_save_response = processor
        .tool_save(ToolSaveParams {
            cwd: temp_dir.path().to_string_lossy().into_owned(),
            config: mcp_config.clone(),
        })
        .await
        .expect("save mcp tool config");
    processor
        .tool_save(ToolSaveParams {
            cwd: temp_dir.path().to_string_lossy().into_owned(),
            config: skill_config,
        })
        .await
        .expect("save skill tool config");

    let list_response = processor
        .tool_list(ToolListParams {
            cwd: temp_dir.path().to_string_lossy().into_owned(),
            kind: Some(ToolConfigKind::Mcp),
            cursor: None,
            limit: Some(1),
        })
        .await
        .expect("list mcp tool configs");

    assert_eq!(list_response.next_cursor, None);
    assert_eq!(list_response.data.len(), 1);
    assert_eq!(list_response.data[0].file_path, mcp_save_response.file_path);
    assert_eq!(list_response.data[0].kind, ToolConfigKind::Mcp);
    assert_eq!(list_response.data[0].config, mcp_config);
}

#[tokio::test]
async fn tool_save_rejects_unknown_kind() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();

    let error = processor
        .tool_save(ToolSaveParams {
            cwd: temp_dir.path().to_string_lossy().into_owned(),
            config: json!({
                "kind": "shell",
                "title": "Shell"
            }),
        })
        .await
        .expect_err("unknown tool kind should fail");

    assert_eq!(error.code, INVALID_PARAMS_ERROR_CODE);
    assert_eq!(
        error.message,
        "tool config is missing required fields".to_string()
    );
}

#[tokio::test]
async fn list_rejects_relative_cwd() {
    let processor = CrewonDomainRequestProcessor::new();

    let error = processor
        .agent_list(AgentListParams {
            cwd: ".".to_string(),
            cursor: None,
            limit: None,
        })
        .await
        .expect_err("relative cwd should fail");

    assert_eq!(error.code, INVALID_PARAMS_ERROR_CODE);
    assert_eq!(error.message, "cwd must be an absolute path".to_string());
}
