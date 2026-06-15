use crewon_app_server_protocol::AgentDeleteParams;
use crewon_app_server_protocol::AgentListParams;
use crewon_app_server_protocol::AgentReadParams;
use crewon_app_server_protocol::AgentRecruitableListParams;
use crewon_app_server_protocol::AgentSaveParams;
use crewon_app_server_protocol::AutomationCreateParams;
use crewon_app_server_protocol::AutomationListParams;
use crewon_app_server_protocol::AutomationRunParams;
use crewon_app_server_protocol::AutomationRunUpdateParams;
use crewon_app_server_protocol::AutomationRunsListParams;
use crewon_app_server_protocol::OfficeApprovalDecideParams;
use crewon_app_server_protocol::OfficeApprovalDecision;
use crewon_app_server_protocol::OfficeArtifactUpsertParams;
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
async fn reads_agent_config_by_identity() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let config = json!({
        "agentId": "agent-reviewer",
        "name": "Reviewer",
        "threadId": "agent-thread-123456789",
        "role": "Review code"
    });
    processor
        .agent_save(AgentSaveParams {
            cwd: cwd.clone(),
            config: config.clone(),
        })
        .await
        .expect("save agent config");

    let read_response = processor
        .agent_read(AgentReadParams {
            cwd,
            agent_id: None,
            thread_id: Some("agent-thread-123456789".to_string()),
            name: None,
        })
        .await
        .expect("read agent config");

    assert_eq!(read_response.record.expect("agent record").config, config);
}

#[tokio::test]
async fn lists_recruitable_agent_configs() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    for config in [
        json!({
            "agentId": "agent-reviewer",
            "name": "Reviewer",
            "role": "Review code"
        }),
        json!({
            "agentId": "agent-builder",
            "name": "Builder",
            "role": "Build features"
        }),
        json!({
            "agentId": "agent-planner",
            "name": "Planner",
            "role": "Plan work"
        }),
    ] {
        processor
            .agent_save(AgentSaveParams {
                cwd: cwd.clone(),
                config,
            })
            .await
            .expect("save agent config");
    }

    let list_response = processor
        .agent_recruitable_list(AgentRecruitableListParams {
            cwd,
            cursor: None,
            existing_agent_ids: Some(vec!["agent-builder".to_string()]),
            existing_names: Some(vec!["Reviewer".to_string()]),
            limit: Some(10),
        })
        .await
        .expect("list recruitable agents");

    assert_eq!(list_response.next_cursor, None);
    assert_eq!(
        list_response
            .data
            .into_iter()
            .map(|record| record.config)
            .collect::<Vec<_>>(),
        vec![json!({
            "agentId": "agent-planner",
            "name": "Planner",
            "role": "Plan work"
        })]
    );
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
async fn automation_run_records_and_lists_runs() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let config = json!({
        "title": "Nightly QA",
        "threadId": "automation-thread-123456789",
        "prompt": "Run QA"
    });

    let run_response = processor
        .automation_run(AutomationRunParams {
            cwd: cwd.clone(),
            config: config.clone(),
            note: Some("manual smoke".to_string()),
            turn_id: Some("turn-123456789".to_string()),
        })
        .await
        .expect("record automation run");
    assert!(run_response.file_path.ends_with(".json"));
    assert_eq!(run_response.run.automation_title, "Nightly QA");
    assert_eq!(
        run_response.run.thread_id,
        Some("automation-thread-123456789".to_string())
    );
    assert_eq!(run_response.run.turn_id, Some("turn-123456789".to_string()));
    assert_eq!(run_response.run.status, "running");
    assert_eq!(run_response.run.note, Some("manual smoke".to_string()));
    assert_eq!(run_response.run.config, config);
    let update_response = processor
        .automation_run_update(AutomationRunUpdateParams {
            cwd: temp_dir.path().to_string_lossy().into_owned(),
            file_path: run_response.file_path.clone(),
            status: "completed".to_string(),
            completed_at: Some(1_800_000_000),
        })
        .await
        .expect("update automation run");
    assert_eq!(update_response.run.status, "completed");
    assert_eq!(update_response.run.completed_at, Some(1_800_000_000));

    let list_response = processor
        .automation_runs_list(AutomationRunsListParams {
            cwd: temp_dir.path().to_string_lossy().into_owned(),
            thread_id: Some("automation-thread-123456789".to_string()),
            cursor: None,
            limit: None,
        })
        .await
        .expect("list updated automation runs");
    assert_eq!(list_response.next_cursor, None);
    assert_eq!(list_response.data.len(), 1);
    assert_eq!(list_response.data[0].file_path, run_response.file_path);
    assert_eq!(list_response.data[0].run, update_response.run);
}

#[tokio::test]
async fn automation_create_builds_structured_config_and_saves_record() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();

    let create_response = processor
        .automation_create(AutomationCreateParams {
            cwd: cwd.clone(),
            title: "Release Monitor".to_string(),
            thread_id: Some("automation-thread-123456789".to_string()),
            target_office: Some(json!({
                "title": "Platform Office",
                "workspace": { "threadId": "office-thread-123456789" }
            })),
            execution_agent: Some(json!({
                "name": "Release Agent",
                "agentId": "agent-release"
            })),
            prompt: Some("Watch release risk".to_string()),
            enabled: Some(true),
            status: Some("enabled".to_string()),
        })
        .await
        .expect("create automation");

    assert!(
        create_response
            .file_path
            .contains(".crewon/automations/release-monitor-")
    );
    assert!(create_response.file_path.ends_with(".json"));
    assert_eq!(
        create_response.config["threadId"],
        json!("automation-thread-123456789")
    );
    assert_eq!(create_response.config["title"], json!("Release Monitor"));
    assert_eq!(
        create_response.config["trigger"],
        json!({ "type": "manual" })
    );
    assert_eq!(
        create_response.config["targetOffice"]["title"],
        json!("Platform Office")
    );
    assert_eq!(
        create_response.config["executionAgent"]["name"],
        json!("Release Agent")
    );
    assert_eq!(create_response.config["enabled"], json!(true));
    assert_eq!(create_response.config["status"], json!("enabled"));

    let list_response = processor
        .automation_list(AutomationListParams {
            cwd,
            cursor: None,
            limit: None,
        })
        .await
        .expect("list automation configs");

    assert_eq!(list_response.data.len(), 1);
    assert_eq!(list_response.data[0].config, create_response.config);
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
            "members": [
                {
                    "name": "Reviewer",
                    "glyph": "R",
                    "accent": "blue"
                }
            ],
            "messages": [
                { "author": "System", "text": "Ready" }
            ],
            "tasks": []
        }
    });
    let message = json!({
        "author": "User",
        "glyph": "@",
        "accent": "slate",
        "time": "09:10",
        "kind": "message",
        "text": "Ship the demo"
    });

    let send_response = processor
        .office_message_send(OfficeMessageSendParams {
            cwd: cwd.clone(),
            config,
            message: message.clone(),
            text: Some("Ship the demo".to_string()),
            locale: Some("en".to_string()),
            workspace: None,
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
            "members": [
                {
                    "name": "Reviewer",
                    "glyph": "R",
                    "accent": "blue"
                }
            ],
            "messages": [
                { "author": "System", "text": "Ready" },
                message,
                {
                    "author": "Reviewer",
                    "glyph": "R",
                    "accent": "blue",
                    "time": send_response.config["workspace"]["messages"][2]["time"],
                    "text": "Got it. I'll take \"Ship the demo\", added it to the task board and will report back here.",
                    "kind": "task"
                }
            ],
            "tasks": [
                {
                    "title": "Ship the demo",
                    "owner": "Reviewer",
                    "status": "doing"
                }
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
async fn office_message_send_saves_workspace_update() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let workspace = json!({
        "threadId": "office-thread-123456789",
        "messages": [
            { "author": "User", "text": "@Reviewer ship demo" },
            { "author": "Reviewer", "text": "I will take it." }
        ],
        "tasks": [
            { "title": "ship demo", "owner": "Reviewer", "status": "doing" }
        ]
    });
    let config = json!({
        "title": "Platform Office",
        "workspace": {
            "threadId": "office-thread-123456789",
            "messages": [],
            "tasks": []
        }
    });
    let message = json!({
        "author": "Reviewer",
        "text": "I will take it."
    });

    let send_response = processor
        .office_message_send(OfficeMessageSendParams {
            cwd: cwd.clone(),
            config,
            message,
            text: None,
            locale: None,
            workspace: Some(workspace.clone()),
        })
        .await
        .expect("send office message with workspace update");
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
        "workspace": workspace
    });
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
async fn office_approval_decide_updates_decision_appends_message_and_saves_config() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let config = json!({
        "title": "Platform Office",
        "workspace": {
            "threadId": "office-thread-123456789",
            "messages": [],
            "activity": {
                "approvals": [
                    {
                        "id": "approval-1",
                        "actor": "Builder",
                        "action": "Deploy",
                        "detail": "Push release",
                        "risk": "medium"
                    }
                ]
            }
        }
    });
    let message = json!({
        "author": "System",
        "kind": "system",
        "text": "Approved approval: Builder - Deploy"
    });

    let decide_response = processor
        .office_approval_decide(OfficeApprovalDecideParams {
            cwd: cwd.clone(),
            config,
            approval_id: "approval-1".to_string(),
            decision: OfficeApprovalDecision::Approved,
            message: Some(message.clone()),
        })
        .await
        .expect("decide office approval");
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
            "messages": [message],
            "activity": {
                "approvals": [
                    {
                        "id": "approval-1",
                        "actor": "Builder",
                        "action": "Deploy",
                        "detail": "Push release",
                        "risk": "medium",
                        "decision": "approved"
                    }
                ]
            }
        }
    });
    assert_eq!(decide_response.config, expected_config);
    assert_eq!(
        read_response.record.expect("office record").config,
        expected_config
    );
}

#[tokio::test]
async fn office_approval_decide_rejects_missing_approval_id() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let error = processor
        .office_approval_decide(OfficeApprovalDecideParams {
            cwd: temp_dir.path().to_string_lossy().into_owned(),
            config: json!({
                "title": "Platform Office",
                "workspace": {
                    "threadId": "office-thread-123456789",
                    "activity": { "approvals": [] }
                }
            }),
            approval_id: "missing".to_string(),
            decision: OfficeApprovalDecision::Denied,
            message: None,
        })
        .await
        .expect_err("missing approval id should fail");

    assert_eq!(error.code, INVALID_PARAMS_ERROR_CODE);
    assert_eq!(error.message, "approvalId was not found".to_string());
}

#[tokio::test]
async fn office_artifact_upsert_replaces_artifact_appends_message_and_saves_config() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let config = json!({
        "title": "Platform Office",
        "workspace": {
            "threadId": "office-thread-123456789",
            "messages": [],
            "activity": {
                "artifacts": [
                    {
                        "title": "Demo Plan",
                        "kind": "markdown",
                        "glyph": "#",
                        "accent": "blue",
                        "meta": "old"
                    },
                    {
                        "title": "Release Notes",
                        "kind": "markdown",
                        "glyph": "#",
                        "accent": "green",
                        "meta": "kept"
                    }
                ]
            }
        }
    });
    let artifact = json!({
        "title": "Demo Plan",
        "kind": "markdown",
        "glyph": "#",
        "accent": "blue",
        "meta": "saved .crewon/offices/artifacts/demo-plan.md"
    });
    let message = json!({
        "author": "System",
        "kind": "system",
        "text": "Created office artifact: Demo Plan"
    });

    let upsert_response = processor
        .office_artifact_upsert(OfficeArtifactUpsertParams {
            cwd: cwd.clone(),
            config,
            artifact: artifact.clone(),
            message: Some(message.clone()),
        })
        .await
        .expect("upsert office artifact");
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
            "messages": [message],
            "activity": {
                "artifacts": [
                    artifact,
                    {
                        "title": "Release Notes",
                        "kind": "markdown",
                        "glyph": "#",
                        "accent": "green",
                        "meta": "kept"
                    }
                ]
            }
        }
    });
    assert_eq!(upsert_response.config, expected_config);
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
