use crewon_app_server_protocol::AgentDeleteParams;
use crewon_app_server_protocol::AgentListParams;
use crewon_app_server_protocol::AgentSaveParams;
use crewon_app_server_protocol::AutomationListParams;
use crewon_app_server_protocol::OfficeMemberAddParams;
use crewon_app_server_protocol::OfficeMessageSendParams;
use crewon_app_server_protocol::OfficeReadParams;
use crewon_app_server_protocol::OfficeSaveParams;
use crewon_app_server_protocol::ToolConfigKind;
use crewon_app_server_protocol::ToolDeleteParams;
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
    assert_eq!(
        list_response.data[0].config,
        json!({
            "agentId": "agent-demo-agent",
            "name": "Demo Agent",
            "threadId": "thread-123456789",
            "role": "Engineer"
        })
    );
    assert!(!list_response.data[0].saved_at.is_empty());
    assert_eq!(save_response.agent_id, "agent-demo-agent");
}

#[tokio::test]
async fn deletes_agent_config_records() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let save_response = processor
        .agent_save(AgentSaveParams {
            cwd: cwd.clone(),
            config: json!({
                "name": "Disposable Agent",
                "threadId": "thread-delete",
            }),
        })
        .await
        .expect("save agent config");

    let delete_response = processor
        .agent_delete(AgentDeleteParams {
            cwd: cwd.clone(),
            file_path: save_response.file_path,
        })
        .await
        .expect("delete agent config");
    let list_response = processor
        .agent_list(AgentListParams {
            cwd,
            cursor: None,
            limit: None,
        })
        .await
        .expect("list agent configs");

    assert!(delete_response.deleted);
    assert_eq!(list_response.data, Vec::new());
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
async fn reads_office_config_by_thread_id() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let config = json!({
        "title": "Platform Office",
        "workspace": {
            "threadId": "office-thread-123456789",
            "messages": []
        }
    });
    processor
        .office_save(OfficeSaveParams {
            cwd: cwd.clone(),
            config: config.clone(),
        })
        .await
        .expect("save office config");

    let read_response = processor
        .office_read(OfficeReadParams {
            cwd,
            thread_id: Some("office-thread-123456789".to_string()),
            title: None,
        })
        .await
        .expect("read office config");

    assert_eq!(read_response.record.expect("office record").config, config);
}

#[tokio::test]
async fn office_message_send_appends_message_and_saves_config() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let config = json!({
        "title": "Platform Office",
        "workspace": {
            "threadId": "office-thread-123456789",
            "messages": [
                { "author": "System", "text": "Ready" }
            ]
        }
    });
    let message = json!({
        "author": "User",
        "text": "Ship the demo"
    });

    let send_response = processor
        .office_message_send(OfficeMessageSendParams {
            cwd: cwd.clone(),
            config,
            message: message.clone(),
        })
        .await
        .expect("send office message");
    let read_response = processor
        .office_read(OfficeReadParams {
            cwd,
            thread_id: Some("office-thread-123456789".to_string()),
            title: None,
        })
        .await
        .expect("read office config");

    let expected_config = json!({
        "title": "Platform Office",
        "workspace": {
            "threadId": "office-thread-123456789",
            "messages": [
                { "author": "System", "text": "Ready" },
                message
            ]
        }
    });
    assert!(
        send_response
            .file_path
            .ends_with(".crewon/offices/platform-office-office-t.json")
    );
    assert_eq!(send_response.config, expected_config);
    assert_eq!(
        read_response.record.expect("office record").config,
        expected_config
    );
}

#[tokio::test]
async fn office_member_add_attaches_agent_id_and_replaces_existing_member() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let config = json!({
        "title": "Platform Office",
        "workspace": {
            "threadId": "office-thread-123456789",
            "members": [
                { "agentId": "agent-reviewer", "name": "Old reviewer" }
            ]
        }
    });
    let member = json!({
        "name": "Reviewer",
        "role": "Code review"
    });

    let add_response = processor
        .office_member_add(OfficeMemberAddParams {
            cwd: cwd.clone(),
            config,
            agent_id: "agent-reviewer".to_string(),
            member,
        })
        .await
        .expect("add office member");
    let read_response = processor
        .office_read(OfficeReadParams {
            cwd,
            thread_id: Some("office-thread-123456789".to_string()),
            title: None,
        })
        .await
        .expect("read office config");

    let expected_config = json!({
        "title": "Platform Office",
        "workspace": {
            "threadId": "office-thread-123456789",
            "members": [
                {
                    "agentId": "agent-reviewer",
                    "name": "Reviewer",
                    "role": "Code review"
                }
            ]
        }
    });
    assert!(
        add_response
            .file_path
            .ends_with(".crewon/offices/platform-office-office-t.json")
    );
    assert_eq!(add_response.config, expected_config);
    assert_eq!(
        read_response.record.expect("office record").config,
        expected_config
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
async fn delete_rejects_config_file_outside_kind_directory() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let save_response = processor
        .tool_save(ToolSaveParams {
            cwd: cwd.clone(),
            config: json!({
                "kind": "mcp",
                "title": "Issue Tracker",
                "name": "linear"
            }),
        })
        .await
        .expect("save tool config");

    let error = processor
        .agent_delete(AgentDeleteParams {
            cwd,
            file_path: save_response.file_path,
        })
        .await
        .expect_err("agent delete should reject tool path");

    assert_eq!(error.code, INVALID_PARAMS_ERROR_CODE);
    assert!(error.message.contains("filePath must be inside"));
}

#[tokio::test]
async fn delete_rejects_wrong_kind_record() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let tools_dir = temp_dir.path().join(".crewon").join("tools");
    std::fs::create_dir_all(&tools_dir).expect("create tools dir");
    let file_path = tools_dir.join("wrong-kind.json");
    std::fs::write(
        &file_path,
        serde_json::to_vec(&json!({
            "version": 1,
            "kind": "agent",
            "savedAt": "2026-06-16T00:00:00.000Z",
            "config": { "name": "Wrong kind" }
        }))
        .expect("serialize wrong kind record"),
    )
    .expect("write wrong kind record");

    let error = processor
        .tool_delete(ToolDeleteParams {
            cwd,
            file_path: file_path.to_string_lossy().into_owned(),
        })
        .await
        .expect_err("tool delete should reject wrong kind record");

    assert_eq!(error.code, INVALID_PARAMS_ERROR_CODE);
    assert_eq!(
        error.message,
        "tool config file does not match the requested kind".to_string()
    );
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
