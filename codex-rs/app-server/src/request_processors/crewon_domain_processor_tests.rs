use crewon_app_server_protocol::AgentCreateParams;
use crewon_app_server_protocol::AgentDeleteParams;
use crewon_app_server_protocol::AgentListParams;
use crewon_app_server_protocol::AgentReadParams;
use crewon_app_server_protocol::AgentRecruitableListParams;
use crewon_app_server_protocol::AgentSaveParams;
use crewon_app_server_protocol::AgentUpdateParams;
use crewon_app_server_protocol::AutomationCreateParams;
use crewon_app_server_protocol::AutomationListParams;
use crewon_app_server_protocol::AutomationRunParams;
use crewon_app_server_protocol::AutomationRunStartParams;
use crewon_app_server_protocol::AutomationRunUpdateParams;
use crewon_app_server_protocol::AutomationRunsListParams;
use crewon_app_server_protocol::AutomationSaveParams;
use crewon_app_server_protocol::CommandExecutionSource;
use crewon_app_server_protocol::CommandExecutionStatus;
use crewon_app_server_protocol::OfficeApprovalDecideParams;
use crewon_app_server_protocol::OfficeApprovalDecision;
use crewon_app_server_protocol::OfficeArtifactUpsertParams;
use crewon_app_server_protocol::OfficeDelegationCancelParams;
use crewon_app_server_protocol::OfficeDelegationDispatchNextParams;
use crewon_app_server_protocol::OfficeDelegationDispatchParams;
use crewon_app_server_protocol::OfficeDelegationRetryParams;
use crewon_app_server_protocol::OfficeMemberAddParams;
use crewon_app_server_protocol::OfficeMemberContextPreviewParams;
use crewon_app_server_protocol::OfficeMemoryDecideParams;
use crewon_app_server_protocol::OfficeMemoryListParams;
use crewon_app_server_protocol::OfficeMessageSendParams;
use crewon_app_server_protocol::OfficeReadParams;
use crewon_app_server_protocol::OfficeRunCancelParams;
use crewon_app_server_protocol::OfficeRunParams;
use crewon_app_server_protocol::OfficeRunRetryParams;
use crewon_app_server_protocol::OfficeRunSyncParams;
use crewon_app_server_protocol::OfficeSaveParams;
use crewon_app_server_protocol::OfficeVerificationCancelParams;
use crewon_app_server_protocol::OfficeVerificationDispatchNextParams;
use crewon_app_server_protocol::OfficeVerificationRetryParams;
use crewon_app_server_protocol::ThreadItem;
use crewon_app_server_protocol::ToolConfigKind;
use crewon_app_server_protocol::ToolDeleteParams;
use crewon_app_server_protocol::ToolListParams;
use crewon_app_server_protocol::ToolSaveParams;
use crewon_app_server_protocol::Turn;
use crewon_app_server_protocol::TurnError;
use crewon_app_server_protocol::TurnItemsView;
use crewon_app_server_protocol::TurnStatus;
use crewon_utils_absolute_path::AbsolutePathBuf;
use pretty_assertions::assert_eq;
use serde_json::Value as JsonValue;
use serde_json::json;
use tempfile::TempDir;

use super::CrewonDomainRequestProcessor;
use super::OfficeVerificationDispatchStarted;
use super::sha256_hex;
use super::sync_automation_runs_for_thread_turn;
use super::sync_office_runs_for_thread_turn;
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
async fn creates_agent_config_without_overwriting_existing_record() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let config = json!({
        "name": "Demo Agent",
        "threadId": "thread-create",
        "role": "Engineer"
    });

    let create_response = processor
        .agent_create(AgentCreateParams {
            cwd: cwd.clone(),
            config: config.clone(),
        })
        .await
        .expect("create agent config");
    assert_eq!(create_response.agent_id, "agent-demo-agent");

    let duplicate_error = processor
        .agent_create(AgentCreateParams { cwd, config })
        .await
        .expect_err("duplicate create should fail");
    assert_eq!(duplicate_error.code, INVALID_PARAMS_ERROR_CODE);
}

#[tokio::test]
async fn updates_agent_config_in_place_when_name_changes() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let create_response = processor
        .agent_create(AgentCreateParams {
            cwd: cwd.clone(),
            config: json!({
                "name": "Original Agent",
                "threadId": "thread-update",
                "role": "Plan"
            }),
        })
        .await
        .expect("create agent config");

    let update_response = processor
        .agent_update(AgentUpdateParams {
            cwd: cwd.clone(),
            file_path: create_response.file_path.clone(),
            config: json!({
                "agentId": "agent-original-agent",
                "name": "Renamed Agent",
                "threadId": "thread-update",
                "role": "Build"
            }),
        })
        .await
        .expect("update agent config");
    assert_eq!(update_response.file_path, create_response.file_path);
    assert_eq!(update_response.agent_id, "agent-original-agent");

    let list_response = processor
        .agent_list(AgentListParams {
            cwd,
            cursor: None,
            limit: None,
        })
        .await
        .expect("list agent configs");
    assert_eq!(list_response.data.len(), 1);
    assert_eq!(list_response.data[0].file_path, create_response.file_path);
    assert_eq!(
        list_response.data[0].config,
        json!({
            "agentId": "agent-original-agent",
            "name": "Renamed Agent",
            "threadId": "thread-update",
            "role": "Build"
        })
    );
}

#[tokio::test]
async fn update_agent_config_rejects_paths_outside_agent_directory() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let outside_path = temp_dir.path().join("outside.json");

    let error = processor
        .agent_update(AgentUpdateParams {
            cwd,
            file_path: outside_path.to_string_lossy().into_owned(),
            config: json!({
                "name": "Outside",
                "role": "Invalid"
            }),
        })
        .await
        .expect_err("outside path should fail");
    assert_eq!(error.code, INVALID_PARAMS_ERROR_CODE);
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
async fn automation_run_start_prepares_turn_prompt_and_records_started_run() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let config = json!({
        "title": "Nightly QA",
        "threadId": "automation-thread-123456789",
        "prompt": "Run QA and summarize evidence"
    });

    let prepared = processor
        .automation_run_start_prepare(AutomationRunStartParams {
            cwd: cwd.clone(),
            config: config.clone(),
            note: Some("manual smoke".to_string()),
            locale: Some("en".to_string()),
            client_user_message_id: Some("client-automation-1".to_string()),
        })
        .await
        .expect("prepare automation run start");

    assert_eq!(prepared.thread_id, "automation-thread-123456789");
    assert_eq!(
        prepared.client_user_message_id.as_deref(),
        Some("client-automation-1")
    );
    assert!(prepared.prompt.contains("Run QA and summarize evidence"));
    assert!(prepared.prompt.contains("Automation: Nightly QA"));
    assert!(prepared.prompt.contains("Run note: manual smoke"));

    let run_response = processor
        .automation_run_start_record(&prepared, "turn-123456789")
        .await
        .expect("record started automation run");
    assert_eq!(run_response.run.automation_title, "Nightly QA");
    assert_eq!(
        run_response.run.thread_id,
        Some("automation-thread-123456789".to_string())
    );
    assert_eq!(run_response.run.turn_id, Some("turn-123456789".to_string()));
    assert_eq!(run_response.run.status, "running");
    assert_eq!(run_response.run.note, Some("manual smoke".to_string()));
    assert_eq!(run_response.run.config, config);
}

#[tokio::test]
async fn automation_run_terminal_sync_updates_matching_turn_record() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let config = json!({
        "title": "Nightly QA",
        "threadId": "automation-thread-123456789",
        "prompt": "Run QA"
    });
    let other_config = json!({
        "title": "Other QA",
        "threadId": "other-thread-123456789",
        "prompt": "Run other QA"
    });
    let run_response = processor
        .automation_run(AutomationRunParams {
            cwd: cwd.clone(),
            config,
            note: None,
            turn_id: Some("turn-123456789".to_string()),
        })
        .await
        .expect("record automation run");
    let other_run_response = processor
        .automation_run(AutomationRunParams {
            cwd: cwd.clone(),
            config: other_config,
            note: None,
            turn_id: Some("turn-123456789".to_string()),
        })
        .await
        .expect("record other automation run");

    let synced = sync_automation_runs_for_thread_turn(
        &cwd,
        "automation-thread-123456789",
        &Turn {
            id: "turn-123456789".to_string(),
            items: Vec::new(),
            items_view: TurnItemsView::NotLoaded,
            status: TurnStatus::Completed,
            error: None,
            started_at: Some(1),
            completed_at: Some(2),
            duration_ms: Some(1_000),
        },
    )
    .await
    .expect("sync automation run");

    assert_eq!(synced, 1);
    let list_response = processor
        .automation_runs_list(AutomationRunsListParams {
            cwd,
            thread_id: None,
            cursor: None,
            limit: None,
        })
        .await
        .expect("list automation runs");
    let updated = list_response
        .data
        .iter()
        .find(|record| record.file_path == run_response.file_path)
        .expect("updated run");
    let other = list_response
        .data
        .iter()
        .find(|record| record.file_path == other_run_response.file_path)
        .expect("other run");
    assert_eq!(updated.run.status, "completed");
    assert_eq!(updated.run.completed_at, Some(2));
    assert_eq!(other.run.status, "running");
    assert_eq!(other.run.completed_at, None);
}

#[tokio::test]
async fn office_verification_dispatch_runs_automation_and_syncs_result() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();

    processor
        .automation_save(AutomationSaveParams {
            cwd: cwd.clone(),
            config: json!({
                "title": "Nightly QA",
                "threadId": "automation-thread-123456789",
                "prompt": "Run QA and report verification evidence"
            }),
        })
        .await
        .expect("save automation config");
    let office_config = json!({
        "title": "Platform Office",
        "workspace": {
            "threadId": "office-thread-123456789",
            "activity": {
                "runs": [
                    {
                        "id": "office-run-1",
                        "title": "Release QA",
                        "status": "completed",
                        "acceptanceCriteria": [
                            {
                                "criterion": "Nightly QA passes",
                                "criterionId": "criteria-nightly",
                                "status": "pending"
                            }
                        ],
                        "verificationChecks": [
                            {
                                "check": "Run nightly QA",
                                "criterionId": "criteria-nightly",
                                "status": "pending",
                                "manualDispatch": true,
                                "riskSeverity": "high",
                                "automationId": "Nightly QA"
                            }
                        ]
                    }
                ]
            }
        }
    });

    let prepared = processor
        .office_verification_dispatch_next_prepare(OfficeVerificationDispatchNextParams {
            cwd: cwd.clone(),
            config: office_config,
            run_id: "office-run-1".to_string(),
            locale: Some("en".to_string()),
            client_user_message_id: Some("client-verification-1".to_string()),
        })
        .await
        .expect("prepare verification dispatch");
    assert_eq!(prepared.automation_id, "Nightly QA");
    assert!(prepared.note.contains("Verification check id"));
    assert!(prepared.note.contains("Run nightly QA"));
    assert_eq!(
        prepared
            .automation_config
            .get("threadId")
            .and_then(JsonValue::as_str),
        Some("automation-thread-123456789")
    );
    let queued_check =
        &prepared.config["workspace"]["activity"]["runs"][0]["verificationChecks"][0];
    let verification_check_id = queued_check["itemId"]
        .as_str()
        .expect("queued check id")
        .to_string();
    assert_eq!(queued_check["dispatchStatus"], "queued");
    assert_eq!(
        queued_check["automationThreadId"],
        "automation-thread-123456789"
    );

    let duplicate = processor
        .office_verification_dispatch_next_prepare(OfficeVerificationDispatchNextParams {
            cwd: cwd.clone(),
            config: prepared.config.clone(),
            run_id: "office-run-1".to_string(),
            locale: Some("en".to_string()),
            client_user_message_id: None,
        })
        .await
        .expect_err("queued verification should not dispatch twice");
    assert!(
        duplicate
            .message
            .contains("no dispatchable office verification check")
    );

    let canceling = processor
        .office_verification_dispatch_next_prepare(OfficeVerificationDispatchNextParams {
            cwd: cwd.clone(),
            config: json!({
                "title": "Platform Office",
                "workspace": {
                    "threadId": "office-thread-123456789",
                    "activity": {
                        "runs": [
                            {
                                "id": "office-run-1",
                                "title": "Release QA",
                                "status": "completed",
                                "verificationChecks": [
                                    {
                                        "check": "Run nightly QA",
                                        "status": "pending",
                                        "dispatchStatus": "canceling",
                                        "automationId": "Nightly QA"
                                    }
                                ]
                            }
                        ]
                    }
                }
            }),
            run_id: "office-run-1".to_string(),
            locale: Some("en".to_string()),
            client_user_message_id: None,
        })
        .await
        .expect_err("canceling verification should not dispatch");
    assert!(
        canceling
            .message
            .contains("no dispatchable office verification check")
    );

    let (file_path, started_config) = processor
        .office_verification_dispatch_mark_started(
            &cwd,
            prepared.config,
            OfficeVerificationDispatchStarted {
                run_id: "office-run-1",
                verification_check_id: &verification_check_id,
                automation_run_file_path: "/workspace/.crewon/automation-runs/nightly.json",
                automation_run_id: "automation-run-1",
                automation_thread_id: "automation-thread-123456789",
                automation_turn_id: "automation-turn-1",
                runtime_repair_source_thread_id: None,
                runtime_repaired_at: None,
            },
        )
        .await
        .expect("mark verification started");
    assert!(file_path.ends_with(".json"));
    let running_check =
        &started_config["workspace"]["activity"]["runs"][0]["verificationChecks"][0];
    assert_eq!(running_check["dispatchStatus"], "running");
    assert_eq!(running_check["automationRunId"], "automation-run-1");
    assert_eq!(running_check["automationTurnId"], "automation-turn-1");

    let synced = sync_office_runs_for_thread_turn(
        &cwd,
        "automation-thread-123456789",
        &Turn {
            id: "automation-turn-1".to_string(),
            items: vec![ThreadItem::AgentMessage {
                id: "agent-message-1".to_string(),
                text: r#"Nightly QA passed.
```json
{
  "officeUpdate": {
    "summary": "Nightly QA passed with smoke coverage.",
    "verificationChecks": [
      {
        "itemId": "office-verification-id",
        "criterionId": "criteria-nightly",
        "automationId": "Nightly QA",
        "status": "passed",
        "evidence": "Smoke suite passed in automation."
      }
    ]
  }
}
```"#
                    .to_string(),
                phase: None,
                memory_citation: None,
            }],
            items_view: TurnItemsView::Full,
            status: TurnStatus::Completed,
            error: None,
            started_at: Some(1),
            completed_at: Some(2),
            duration_ms: Some(1_000),
        },
    )
    .await
    .expect("sync office verification turn");
    assert_eq!(synced, 1);

    let read_response = processor
        .office_read(OfficeReadParams {
            cwd,
            thread_id: Some("office-thread-123456789".to_string()),
            title: None,
        })
        .await
        .expect("read updated office");
    let config = read_response.record.expect("office record").config;
    let run = &config["workspace"]["activity"]["runs"][0];
    assert_eq!(run["verificationChecks"][0]["status"], "passed");
    assert_eq!(run["verificationChecks"][0]["dispatchStatus"], "completed");
    assert_eq!(
        run["verificationChecks"][0]["evidence"],
        "Smoke suite passed in automation."
    );
    assert_eq!(run["acceptanceCriteria"][0]["status"], "passed");
    assert_eq!(run["evidence"][0]["evidenceKind"], "automationRun");
    assert_eq!(run["loop"]["review"]["status"], "passed");
}

#[tokio::test]
async fn office_verification_retry_requeues_failed_automation_check() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();

    processor
        .automation_save(AutomationSaveParams {
            cwd: cwd.clone(),
            config: json!({
                "title": "Nightly QA",
                "threadId": "automation-thread-123456789",
                "prompt": "Run QA and report verification evidence"
            }),
        })
        .await
        .expect("save automation config");
    let office_config = json!({
        "title": "Platform Office",
        "workspace": {
            "threadId": "office-thread-123456789",
            "activity": {
                "runs": [
                    {
                        "id": "office-run-1",
                        "title": "Release QA",
                        "status": "completed",
                        "verificationChecks": [
                            {
                                "itemId": "verification-nightly",
                                "check": "Run nightly QA",
                                "criterionId": "criteria-nightly",
                                "status": "failed",
                                "dispatchStatus": "failed",
                                "automationStatus": "failed",
                                "automationId": "Nightly QA",
                                "automationRunFilePath": "/workspace/.crewon/automation-runs/nightly-old.json",
                                "automationRunId": "automation-run-old",
                                "automationThreadId": "automation-thread-123456789",
                                "automationTurnId": "automation-turn-old",
                                "evidence": "Smoke automation failed.",
                                "error": "Smoke suite failed"
                            }
                        ]
                    }
                ]
            }
        }
    });
    processor
        .office_save(OfficeSaveParams {
            cwd: cwd.clone(),
            config: office_config.clone(),
        })
        .await
        .expect("save office");

    let prepared = processor
        .office_verification_retry_prepare(OfficeVerificationRetryParams {
            cwd: cwd.clone(),
            config: office_config,
            run_id: "office-run-1".to_string(),
            verification_check_id: "verification-nightly".to_string(),
            locale: Some("en".to_string()),
            client_user_message_id: Some("client-verification-retry-1".to_string()),
        })
        .await
        .expect("prepare verification retry");

    assert_eq!(prepared.automation_id, "Nightly QA");
    assert_eq!(
        prepared.retry_of_automation_turn_id.as_deref(),
        Some("automation-turn-old")
    );
    assert!(
        prepared
            .note
            .contains("Retry of automation turn: automation-turn-old")
    );
    assert!(prepared.note.contains("Previous error: Smoke suite failed"));

    let queued_check =
        &prepared.config["workspace"]["activity"]["runs"][0]["verificationChecks"][0];
    assert_eq!(
        json!({
            "itemId": queued_check["itemId"].clone(),
            "status": queued_check["status"].clone(),
            "dispatchStatus": queued_check["dispatchStatus"].clone(),
            "automationId": queued_check["automationId"].clone(),
            "automationThreadId": queued_check["automationThreadId"].clone(),
            "retryOfAutomationTurnId": queued_check["retryOfAutomationTurnId"].clone(),
            "automationTurnId": queued_check["automationTurnId"].clone(),
            "error": queued_check["error"].clone(),
            "evidence": queued_check["evidence"].clone(),
        }),
        json!({
            "itemId": "verification-nightly",
            "status": "pending",
            "dispatchStatus": "queued",
            "automationId": "Nightly QA",
            "automationThreadId": "automation-thread-123456789",
            "retryOfAutomationTurnId": "automation-turn-old",
            "automationTurnId": null,
            "error": null,
            "evidence": null,
        })
    );
    assert_eq!(
        json!({
            "status": queued_check["attempts"][0]["status"].clone(),
            "dispatchStatus": queued_check["attempts"][0]["dispatchStatus"].clone(),
            "automationRunId": queued_check["attempts"][0]["automationRunId"].clone(),
            "automationTurnId": queued_check["attempts"][0]["automationTurnId"].clone(),
            "error": queued_check["attempts"][0]["error"].clone(),
            "evidence": queued_check["attempts"][0]["evidence"].clone(),
        }),
        json!({
            "status": "failed",
            "dispatchStatus": "failed",
            "automationRunId": "automation-run-old",
            "automationTurnId": "automation-turn-old",
            "error": "Smoke suite failed",
            "evidence": "Smoke automation failed.",
        })
    );

    let (_, started_config) = processor
        .office_verification_dispatch_mark_started(
            &cwd,
            prepared.config.clone(),
            OfficeVerificationDispatchStarted {
                run_id: "office-run-1",
                verification_check_id: "verification-nightly",
                automation_run_file_path: "/workspace/.crewon/automation-runs/nightly-retry.json",
                automation_run_id: "automation-run-retry",
                automation_thread_id: "automation-thread-123456789",
                automation_turn_id: "automation-turn-retry",
                runtime_repair_source_thread_id: None,
                runtime_repaired_at: None,
            },
        )
        .await
        .expect("mark verification retry started");
    let running_check =
        &started_config["workspace"]["activity"]["runs"][0]["verificationChecks"][0];
    assert_eq!(
        json!({
            "status": running_check["status"].clone(),
            "dispatchStatus": running_check["dispatchStatus"].clone(),
            "automationRunId": running_check["automationRunId"].clone(),
            "automationTurnId": running_check["automationTurnId"].clone(),
            "retryOfAutomationTurnId": running_check["retryOfAutomationTurnId"].clone(),
        }),
        json!({
            "status": "pending",
            "dispatchStatus": "running",
            "automationRunId": "automation-run-retry",
            "automationTurnId": "automation-turn-retry",
            "retryOfAutomationTurnId": "automation-turn-old",
        })
    );

    let duplicate_retry = processor
        .office_verification_retry_prepare(OfficeVerificationRetryParams {
            cwd,
            config: started_config,
            run_id: "office-run-1".to_string(),
            verification_check_id: "verification-nightly".to_string(),
            locale: Some("en".to_string()),
            client_user_message_id: None,
        })
        .await
        .expect_err("running verification retry should block duplicate retry");
    assert_eq!(
        duplicate_retry.message,
        "office verification retry is already active"
    );
}

#[tokio::test]
async fn office_auto_verification_dispatch_continues_after_passed_automation_turn() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();

    processor
        .automation_create(AutomationCreateParams {
            cwd: cwd.clone(),
            title: "Nightly QA".to_string(),
            thread_id: Some("automation-thread-123456789".to_string()),
            target_office: None,
            execution_agent: None,
            prompt: Some("Run nightly checks".to_string()),
            enabled: Some(true),
            status: Some("enabled".to_string()),
        })
        .await
        .expect("create automation");

    let office_config = json!({
        "title": "Platform Office",
        "workspace": {
            "threadId": "office-thread-123456789",
            "activity": {
                "runs": [
                    {
                        "id": "office-run-1",
                        "title": "Release QA",
                        "status": "completed",
                        "turnId": "manager-turn-1",
                        "verificationChecks": [
                            {
                                "itemId": "verification-smoke",
                                "check": "Run smoke QA",
                                "status": "passed",
                                "dispatchStatus": "completed",
                                "automationId": "Nightly QA",
                                "automationThreadId": "automation-thread-123456789",
                                "automationTurnId": "automation-turn-1"
                            },
                            {
                                "itemId": "verification-regression",
                                "check": "Run manual regression QA",
                                "status": "pending",
                                "manualDispatch": true,
                                "automationId": "Nightly QA"
                            },
                            {
                                "itemId": "verification-risky",
                                "check": "Run risky regression QA",
                                "status": "pending",
                                "riskSeverity": "high",
                                "automationId": "Nightly QA"
                            },
                            {
                                "itemId": "verification-canceling",
                                "check": "Canceling regression QA",
                                "status": "pending",
                                "dispatchStatus": "canceling",
                                "automationId": "Nightly QA"
                            },
                            {
                                "itemId": "verification-safe",
                                "check": "Run safe regression QA",
                                "status": "pending",
                                "automationId": "Nightly QA"
                            }
                        ]
                    }
                ]
            }
        }
    });
    processor
        .office_save(OfficeSaveParams {
            cwd: cwd.clone(),
            config: office_config,
        })
        .await
        .expect("save office");

    let prepared = processor
        .office_auto_verification_dispatch_prepare_after_thread_turn(
            &cwd,
            "automation-thread-123456789",
            &Turn {
                id: "automation-turn-1".to_string(),
                items: Vec::new(),
                items_view: TurnItemsView::Full,
                status: TurnStatus::Completed,
                error: None,
                started_at: Some(1),
                completed_at: Some(2),
                duration_ms: Some(1_000),
            },
        )
        .await
        .expect("prepare auto verification dispatch")
        .expect("next verification dispatch");

    assert_eq!(prepared.run_id, "office-run-1");
    assert_eq!(prepared.verification_check_id, "verification-safe");
    assert_eq!(prepared.automation_id, "Nightly QA");
    assert!(
        prepared
            .client_user_message_id
            .as_deref()
            .is_some_and(|id| id.starts_with("office-auto-verification-"))
    );
    assert!(prepared.note.contains("Run safe regression QA"));
    let checks = prepared.config["workspace"]["activity"]["runs"][0]["verificationChecks"]
        .as_array()
        .expect("verification checks");
    assert_eq!(checks[0]["dispatchStatus"], "completed");
    assert!(checks[1].get("dispatchStatus").is_none());
    assert!(checks[2].get("dispatchStatus").is_none());
    assert_eq!(checks[3]["dispatchStatus"], "canceling");
    assert_eq!(checks[4]["dispatchStatus"], "queued");
    assert_eq!(
        checks[4]["automationThreadId"],
        "automation-thread-123456789"
    );

    let duplicate = processor
        .office_auto_verification_dispatch_prepare_after_thread_turn(
            &cwd,
            "automation-thread-123456789",
            &Turn {
                id: "automation-turn-1".to_string(),
                items: Vec::new(),
                items_view: TurnItemsView::Full,
                status: TurnStatus::Completed,
                error: None,
                started_at: Some(1),
                completed_at: Some(2),
                duration_ms: Some(1_000),
            },
        )
        .await
        .expect("duplicate prepare should be a no-op");
    assert!(duplicate.is_none());
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
async fn office_run_prepare_records_run_and_mark_started_attaches_turn_id() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let config = json!({
        "title": "Platform Office",
        "workspace": {
            "goal": "Ship the backend office",
            "threadId": "office-thread-123456789",
            "members": [
                {
                    "name": "Planner",
                    "role": "Plan work",
                    "status": "idle"
                }
            ],
            "messages": [],
            "tasks": [],
            "activity": {
                "approvals": [],
                "artifacts": []
            }
        }
    });
    let message = json!({
        "author": "User",
        "glyph": "@",
        "accent": "slate",
        "time": "09:10",
        "kind": "message",
        "text": "Design and implement office runs"
    });

    let prepared = processor
        .office_run_prepare(OfficeRunParams {
            cwd: cwd.clone(),
            config,
            message: message.clone(),
            text: "Design and implement office runs".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: Some("client-message-1".to_string()),
        })
        .await
        .expect("prepare office run");
    let (file_path, started_config) = processor
        .office_run_mark_started(&cwd, prepared.config.clone(), &prepared.run_id, "turn-1")
        .await
        .expect("mark office run started");
    let read_response = processor
        .office_read(OfficeReadParams {
            cwd,
            thread_id: Some("office-thread-123456789".to_string()),
            title: None,
        })
        .await
        .expect("read office config");

    assert_eq!(prepared.thread_id, "office-thread-123456789");
    assert_eq!(
        prepared.client_user_message_id.as_deref(),
        Some("client-message-1")
    );
    assert!(prepared.prompt.contains("Agent team turn"));
    assert!(prepared.prompt.contains("Design and implement office runs"));
    assert!(
        prepared
            .prompt
            .contains("criterionId as a stable acceptance id")
    );
    assert!(
        prepared
            .prompt
            .contains("{\"check\":\"Run tests\",\"criterionId\":\"criteria-tests\"")
    );
    assert!(file_path.ends_with(".crewon/offices/platform-office-office-t.json"));
    assert_eq!(started_config["workspace"]["messages"][0], message);
    assert_eq!(
        started_config["workspace"]["messages"][1]["text"],
        "Started team run: Design and implement office runs"
    );
    assert_eq!(
        started_config["workspace"]["tasks"][0],
        json!({
            "title": "Design and implement office runs",
            "owner": "Team",
            "status": "doing",
            "runId": prepared.run_id.clone()
        })
    );
    assert_eq!(
        started_config["workspace"]["activity"]["runs"][0]["id"],
        prepared.run_id
    );
    assert_eq!(
        started_config["workspace"]["activity"]["runs"][0]["status"],
        "running"
    );
    assert_eq!(
        started_config["workspace"]["activity"]["runs"][0]["turnId"],
        "turn-1"
    );
    let loop_state = &started_config["workspace"]["activity"]["runs"][0]["loop"];
    assert_eq!(loop_state["iteration"], 1);
    assert_eq!(loop_state["maxIterations"], 4);
    assert_eq!(loop_state["phase"], "frame");
    assert_eq!(loop_state["status"], "continue");
    assert_eq!(loop_state["review"]["status"], "incomplete");
    assert_eq!(
        loop_state["review"]["nextAction"],
        "frameAcceptanceCriteria"
    );
    assert_eq!(loop_state["metrics"]["iteration"], 1);
    assert_eq!(loop_state["metrics"]["acceptance"]["total"], 0);
    assert!(
        loop_state["stopConditions"]
            .as_array()
            .expect("loop stop conditions")
            .iter()
            .any(
                |condition| condition["condition"] == "acceptanceCriteriaDefined"
                    && condition["met"] == false
            )
    );
    assert_eq!(
        read_response.record.expect("office record").config,
        started_config
    );
}

#[tokio::test]
async fn office_run_prepare_resolves_member_runtime_from_saved_agent() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    processor
        .agent_save(AgentSaveParams {
            cwd: cwd.clone(),
            config: json!({
                "agentId": "agent-reviewer",
                "name": "Reviewer",
                "threadId": "reviewer-thread-123456789",
                "role": "Code review",
                "instructions": "Focus on correctness, regressions, and test evidence.",
                "skills": ["Rust", "integration tests"]
            }),
        })
        .await
        .expect("save reviewer agent");

    let prepared = processor
        .office_run_prepare(OfficeRunParams {
            cwd,
            config: json!({
                "title": "Platform Office",
                "workspace": {
                    "goal": "Ship the backend office",
                    "threadId": "office-thread-123456789",
                    "members": [{
                        "name": "Reviewer",
                        "role": "Review final changes",
                        "status": "online",
                        "agentId": "agent-reviewer"
                    }],
                    "messages": [],
                    "tasks": [],
                    "activity": {
                        "approvals": [],
                        "artifacts": []
                    }
                }
            }),
            message: json!({
                "author": "User",
                "text": "Review the office backend"
            }),
            text: "Review the office backend".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare office run");

    assert_eq!(
        prepared.config["workspace"]["members"][0]["runtime"],
        json!({
            "threadId": "reviewer-thread-123456789",
            "contextPolicy": "sharedDigest",
            "memoryScope": "privateAndShared",
            "agentProfile": "role=Code review; instructions=Focus on correctness, regressions, and test evidence.; skills=Rust, integration tests"
        })
    );
    assert!(prepared.prompt.contains("agentId=agent-reviewer"));
    assert!(
        prepared
            .prompt
            .contains("runtimeThreadId=reviewer-thread-123456789")
    );
    assert!(prepared.prompt.contains("Delegation routes"));
    assert!(prepared.prompt.contains("target=reviewer-thread-123456789"));
    assert!(
        prepared.prompt.contains(
            "agentProfile=role=Code review; instructions=Focus on correctness, regressions, and test evidence.; skills=Rust, integration tests"
        )
    );
    assert_eq!(
        prepared.config["workspace"]["activity"]["runs"][0]["delegationRoutes"][0],
        json!({
            "member": "Reviewer",
            "agentId": "agent-reviewer",
            "threadId": "reviewer-thread-123456789",
            "target": "reviewer-thread-123456789",
            "targetKind": "runtimeThread",
            "tool": "followup_task",
            "contextPolicy": "sharedDigest",
            "memoryScope": "privateAndShared",
            "agentProfile": "role=Code review; instructions=Focus on correctness, regressions, and test evidence.; skills=Rust, integration tests"
        })
    );

    let (_, started_config) = processor
        .office_run_mark_started(&prepared.cwd, prepared.config, &prepared.run_id, "turn-1")
        .await
        .expect("mark office run started");
    let sync_response = processor
        .office_run_sync(OfficeRunSyncParams {
            cwd: prepared.cwd,
            config: started_config,
            run_id: Some(prepared.run_id),
            turn: Turn {
                id: "turn-1".to_string(),
                items: vec![ThreadItem::AgentMessage {
                    id: "agent-message-1".to_string(),
                    text: r#"Done.
```json
{
  "officeUpdate": {
    "summary": "Review routed.",
    "delegations": [
      { "member": "Reviewer", "agentId": "agent-reviewer", "task": "Review backend", "status": "done" }
    ]
  }
}
```"#
                    .to_string(),
                    phase: None,
                    memory_citation: None,
                }],
                items_view: TurnItemsView::Full,
                status: TurnStatus::Completed,
                error: None,
                started_at: Some(1),
                completed_at: Some(2),
                duration_ms: Some(1_000),
            },
            locale: Some("en".to_string()),
        })
        .await
        .expect("sync routed office run");
    assert_eq!(
        sync_response.config["workspace"]["activity"]["runs"][0]["delegations"][0]["threadId"],
        "reviewer-thread-123456789"
    );
    assert_eq!(
        sync_response.config["workspace"]["activity"]["runs"][0]["delegations"][0]["target"],
        "reviewer-thread-123456789"
    );
    assert_eq!(
        sync_response.config["workspace"]["activity"]["runs"][0]["delegations"][0]["tool"],
        "followup_task"
    );
}

#[tokio::test]
async fn office_delegation_dispatch_routes_task_to_member_runtime() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    processor
        .agent_save(AgentSaveParams {
            cwd: cwd.clone(),
            config: json!({
                "agentId": "agent-reviewer",
                "name": "Reviewer",
                "threadId": "reviewer-thread-123456789",
                "role": "Code review"
            }),
        })
        .await
        .expect("save reviewer agent");
    let prepared_run = processor
        .office_run_prepare(OfficeRunParams {
            cwd: cwd.clone(),
            config: json!({
                "title": "Platform Office",
                "workspace": {
                    "goal": "Ship the backend office",
                    "threadId": "office-thread-123456789",
                    "members": [{
                        "name": "Reviewer",
                        "role": "Review final changes",
                        "status": "online",
                        "agentId": "agent-reviewer"
                    }],
                    "messages": [],
                    "tasks": [],
                    "activity": {
                        "approvals": [],
                        "artifacts": []
                    }
                }
            }),
            message: json!({
                "author": "User",
                "text": "Ship routed dispatch"
            }),
            text: "Ship routed dispatch".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare office run");

    let prepared_dispatch = processor
        .office_delegation_dispatch_prepare(OfficeDelegationDispatchParams {
            cwd: cwd.clone(),
            config: prepared_run.config,
            run_id: prepared_run.run_id.clone(),
            task: "Review the deterministic dispatch adapter".to_string(),
            member: Some("Reviewer".to_string()),
            agent_id: None,
            locale: Some("en".to_string()),
            client_user_message_id: Some("client-delegation-1".to_string()),
        })
        .await
        .expect("prepare routed delegation dispatch");

    assert_eq!(prepared_dispatch.thread_id, "reviewer-thread-123456789");
    assert_eq!(
        prepared_dispatch.client_user_message_id.as_deref(),
        Some("client-delegation-1")
    );
    assert!(prepared_dispatch.prompt.contains("Office member Reviewer"));
    assert!(
        prepared_dispatch
            .prompt
            .contains("Review the deterministic dispatch adapter")
    );
    assert!(
        prepared_dispatch
            .prompt
            .contains("Verification schema supplement")
    );
    assert!(
        prepared_dispatch
            .prompt
            .contains("Agent profile (bounded): role=Code review")
    );
    assert!(
        prepared_dispatch
            .prompt
            .contains("{\"check\":\"Run member verification\",\"criterionId\":\"criteria-tests\"")
    );
    let delegation =
        &prepared_dispatch.config["workspace"]["activity"]["runs"][0]["delegations"][0];
    assert_eq!(delegation["member"], "Reviewer");
    assert_eq!(delegation["agentId"], "agent-reviewer");
    assert_eq!(delegation["target"], "reviewer-thread-123456789");
    assert_eq!(delegation["status"], "queued");
    assert_eq!(delegation["dispatchMethod"], "turnStart");

    let (_, started_config) = processor
        .office_delegation_dispatch_mark_started(
            &cwd,
            prepared_dispatch.config,
            &prepared_run.run_id,
            &prepared_dispatch.delegation_id,
            "turn-delegation-1",
        )
        .await
        .expect("mark delegation started");
    let delegation = &started_config["workspace"]["activity"]["runs"][0]["delegations"][0];
    assert_eq!(delegation["status"], "running");
    assert_eq!(delegation["turnId"], "turn-delegation-1");
}

#[tokio::test]
async fn office_delegation_dispatch_claims_planned_delegation_and_rejects_duplicate() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    processor
        .agent_save(AgentSaveParams {
            cwd: cwd.clone(),
            config: json!({
                "agentId": "agent-reviewer",
                "name": "Reviewer",
                "threadId": "reviewer-thread-123456789",
                "role": "Code review"
            }),
        })
        .await
        .expect("save reviewer agent");
    let prepared_run = processor
        .office_run_prepare(OfficeRunParams {
            cwd: cwd.clone(),
            config: json!({
                "title": "Platform Office",
                "workspace": {
                    "goal": "Ship the backend office",
                    "threadId": "office-thread-123456789",
                    "members": [{
                        "name": "Reviewer",
                        "role": "Review final changes",
                        "status": "online",
                        "agentId": "agent-reviewer"
                    }],
                    "messages": [],
                    "tasks": [],
                    "activity": {
                        "approvals": [],
                        "artifacts": []
                    }
                }
            }),
            message: json!({
                "author": "User",
                "text": "Plan a member review"
            }),
            text: "Plan a member review".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare office run");
    let (_, started_config) = processor
        .office_run_mark_started(&cwd, prepared_run.config, &prepared_run.run_id, "turn-1")
        .await
        .expect("mark office run started");
    let planned = processor
        .office_run_sync(OfficeRunSyncParams {
            cwd: cwd.clone(),
            config: started_config,
            run_id: Some(prepared_run.run_id.clone()),
            turn: Turn {
                id: "turn-1".to_string(),
                items: vec![ThreadItem::AgentMessage {
                    id: "agent-message-1".to_string(),
                    text: r#"Planning.
```json
{
  "officeUpdate": {
    "summary": "Review planned.",
    "delegations": [
      {
        "member": "Reviewer",
        "agentId": "agent-reviewer",
        "task": "Review dispatch idempotency",
        "status": "queued"
      }
    ]
  }
}
```"#
                        .to_string(),
                    phase: None,
                    memory_citation: None,
                }],
                items_view: TurnItemsView::Full,
                status: TurnStatus::InProgress,
                error: None,
                started_at: Some(1),
                completed_at: None,
                duration_ms: None,
            },
            locale: Some("en".to_string()),
        })
        .await
        .expect("sync planned delegation");
    assert_eq!(
        planned.config["workspace"]["activity"]["runs"][0]["delegations"]
            .as_array()
            .expect("planned delegations")
            .len(),
        1
    );

    let prepared_dispatch = processor
        .office_delegation_dispatch_prepare(OfficeDelegationDispatchParams {
            cwd: cwd.clone(),
            config: planned.config,
            run_id: prepared_run.run_id.clone(),
            task: "Review dispatch idempotency".to_string(),
            member: Some("Reviewer".to_string()),
            agent_id: None,
            locale: Some("en".to_string()),
            client_user_message_id: None,
        })
        .await
        .expect("claim planned delegation");
    let delegations = prepared_dispatch.config["workspace"]["activity"]["runs"][0]["delegations"]
        .as_array()
        .expect("delegations");
    assert_eq!(delegations.len(), 1);
    assert_eq!(delegations[0]["id"], prepared_dispatch.delegation_id);
    assert_eq!(delegations[0]["status"], "queued");
    assert_eq!(delegations[0]["dispatchMethod"], "turnStart");
    assert_eq!(delegations[0]["target"], "reviewer-thread-123456789");

    let duplicate_error = processor
        .office_delegation_dispatch_prepare(OfficeDelegationDispatchParams {
            cwd: cwd.clone(),
            config: prepared_dispatch.config.clone(),
            run_id: prepared_run.run_id,
            task: "Review dispatch idempotency".to_string(),
            member: Some("Reviewer".to_string()),
            agent_id: None,
            locale: Some("en".to_string()),
            client_user_message_id: None,
        })
        .await
        .expect_err("duplicate dispatch should be rejected");
    assert_eq!(duplicate_error.code, INVALID_PARAMS_ERROR_CODE);
    assert_eq!(
        duplicate_error.message,
        "office delegation has already been dispatched"
    );

    processor
        .office_delegation_dispatch_mark_failed(
            &cwd,
            prepared_dispatch.config.clone(),
            &prepared_dispatch.run_id,
            &prepared_dispatch.delegation_id,
            "member startup failed",
        )
        .await
        .expect("mark startup failure");
    let retry_dispatch = processor
        .office_delegation_dispatch_prepare(OfficeDelegationDispatchParams {
            cwd,
            config: prepared_dispatch.config,
            run_id: prepared_dispatch.run_id,
            task: "Review dispatch idempotency".to_string(),
            member: Some("Reviewer".to_string()),
            agent_id: None,
            locale: Some("en".to_string()),
            client_user_message_id: None,
        })
        .await
        .expect("retry failed startup delegation");
    assert_eq!(
        retry_dispatch.delegation_id,
        prepared_dispatch.delegation_id
    );
    let delegation = &retry_dispatch.config["workspace"]["activity"]["runs"][0]["delegations"][0];
    assert_eq!(delegation["status"], "queued");
    assert!(delegation.get("error").is_none());
}

#[tokio::test]
async fn office_delegation_dispatch_next_claims_first_routable_planned_delegation() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    processor
        .agent_save(AgentSaveParams {
            cwd: cwd.clone(),
            config: json!({
                "agentId": "agent-reviewer",
                "name": "Reviewer",
                "threadId": "reviewer-thread-123456789",
                "role": "Code review"
            }),
        })
        .await
        .expect("save reviewer agent");
    let prepared_run = processor
        .office_run_prepare(OfficeRunParams {
            cwd: cwd.clone(),
            config: json!({
                "title": "Platform Office",
                "workspace": {
                    "goal": "Ship the backend office",
                    "threadId": "office-thread-123456789",
                    "members": [{
                        "name": "Reviewer",
                        "role": "Review final changes",
                        "status": "online",
                        "agentId": "agent-reviewer"
                    }],
                    "messages": [],
                    "tasks": [],
                    "activity": {
                        "approvals": [],
                        "artifacts": []
                    }
                }
            }),
            message: json!({
                "author": "User",
                "text": "Plan member reviews"
            }),
            text: "Plan member reviews".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare office run");
    let (_, started_config) = processor
        .office_run_mark_started(&cwd, prepared_run.config, &prepared_run.run_id, "turn-1")
        .await
        .expect("mark office run started");
    let planned = processor
        .office_run_sync(OfficeRunSyncParams {
            cwd: cwd.clone(),
            config: started_config,
            run_id: Some(prepared_run.run_id.clone()),
            turn: Turn {
                id: "turn-1".to_string(),
                items: vec![ThreadItem::AgentMessage {
                    id: "agent-message-1".to_string(),
                    text: r#"Planning.
```json
{
  "officeUpdate": {
    "summary": "Reviews planned.",
    "delegations": [
      {
        "member": "Ghost",
        "agentId": "agent-missing",
        "task": "This has no runtime route",
        "status": "queued"
      },
      {
        "member": "Reviewer",
        "agentId": "agent-reviewer",
        "task": "Review dispatch next behavior",
        "status": "queued"
      }
    ]
  }
}
```"#
                        .to_string(),
                    phase: None,
                    memory_citation: None,
                }],
                items_view: TurnItemsView::Full,
                status: TurnStatus::InProgress,
                error: None,
                started_at: Some(1),
                completed_at: None,
                duration_ms: None,
            },
            locale: Some("en".to_string()),
        })
        .await
        .expect("sync planned delegations");

    let prepared_dispatch = processor
        .office_delegation_dispatch_next_prepare(OfficeDelegationDispatchNextParams {
            cwd,
            config: planned.config,
            run_id: prepared_run.run_id,
            dispatch_policy: None,
            locale: Some("en".to_string()),
            client_user_message_id: Some("dispatch-next-1".to_string()),
        })
        .await
        .expect("prepare next delegation dispatch");
    assert_eq!(prepared_dispatch.thread_id, "reviewer-thread-123456789");
    assert_eq!(
        prepared_dispatch.client_user_message_id.as_deref(),
        Some("dispatch-next-1")
    );
    assert!(
        prepared_dispatch
            .prompt
            .contains("Review dispatch next behavior")
    );
    let delegations = prepared_dispatch.config["workspace"]["activity"]["runs"][0]["delegations"]
        .as_array()
        .expect("delegations");
    assert_eq!(delegations.len(), 2);
    assert_eq!(delegations[0]["member"], "Ghost");
    assert_eq!(delegations[1]["id"], prepared_dispatch.delegation_id);
    assert_eq!(delegations[1]["dispatchMethod"], "turnStart");
    assert_eq!(delegations[1]["target"], "reviewer-thread-123456789");
}

#[tokio::test]
async fn office_delegation_dispatch_next_uses_latest_state_for_stale_clients() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    for agent in [
        json!({
            "agentId": "agent-reviewer",
            "name": "Reviewer",
            "threadId": "reviewer-thread-123456789",
            "role": "Code review"
        }),
        json!({
            "agentId": "agent-implementer",
            "name": "Implementer",
            "threadId": "implementer-thread-123456789",
            "role": "Implementation"
        }),
    ] {
        processor
            .agent_save(AgentSaveParams {
                cwd: cwd.clone(),
                config: agent,
            })
            .await
            .expect("save agent");
    }
    let prepared_run = processor
        .office_run_prepare(OfficeRunParams {
            cwd: cwd.clone(),
            config: json!({
                "title": "Platform Office",
                "workspace": {
                    "goal": "Ship the backend office",
                    "threadId": "office-thread-123456789",
                    "members": [
                        {
                            "name": "Reviewer",
                            "role": "Review final changes",
                            "status": "online",
                            "agentId": "agent-reviewer"
                        },
                        {
                            "name": "Implementer",
                            "role": "Implement final changes",
                            "status": "online",
                            "agentId": "agent-implementer"
                        }
                    ],
                    "messages": [],
                    "tasks": [],
                    "activity": {
                        "approvals": [],
                        "artifacts": []
                    }
                }
            }),
            message: json!({
                "author": "User",
                "text": "Plan implementation and review"
            }),
            text: "Plan implementation and review".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare office run");
    let (_, started_config) = processor
        .office_run_mark_started(&cwd, prepared_run.config, &prepared_run.run_id, "turn-1")
        .await
        .expect("mark office run started");
    let planned = processor
        .office_run_sync(OfficeRunSyncParams {
            cwd: cwd.clone(),
            config: started_config,
            run_id: Some(prepared_run.run_id.clone()),
            turn: Turn {
                id: "turn-1".to_string(),
                items: vec![ThreadItem::AgentMessage {
                    id: "agent-message-1".to_string(),
                    text: r#"Planning.
```json
{
  "officeUpdate": {
    "summary": "Implementation and review planned.",
    "delegations": [
      {
        "member": "Reviewer",
        "agentId": "agent-reviewer",
        "task": "Review the final patch",
        "status": "queued"
      },
      {
        "member": "Implementer",
        "agentId": "agent-implementer",
        "task": "Implement the final patch",
        "status": "queued"
      }
    ]
  }
}
```"#
                        .to_string(),
                    phase: None,
                    memory_citation: None,
                }],
                items_view: TurnItemsView::Full,
                status: TurnStatus::InProgress,
                error: None,
                started_at: Some(1),
                completed_at: None,
                duration_ms: None,
            },
            locale: Some("en".to_string()),
        })
        .await
        .expect("sync planned delegations");
    let stale_planned_config = planned.config.clone();

    let reviewer_dispatch = processor
        .office_delegation_dispatch_next_prepare(OfficeDelegationDispatchNextParams {
            cwd: cwd.clone(),
            config: stale_planned_config.clone(),
            run_id: prepared_run.run_id.clone(),
            dispatch_policy: None,
            locale: Some("en".to_string()),
            client_user_message_id: Some("dispatch-reviewer".to_string()),
        })
        .await
        .expect("dispatch reviewer");
    let implementer_dispatch = processor
        .office_delegation_dispatch_next_prepare(OfficeDelegationDispatchNextParams {
            cwd: cwd.clone(),
            config: stale_planned_config,
            run_id: prepared_run.run_id,
            dispatch_policy: None,
            locale: Some("en".to_string()),
            client_user_message_id: Some("dispatch-implementer".to_string()),
        })
        .await
        .expect("dispatch implementer from stale snapshot");

    assert_eq!(reviewer_dispatch.thread_id, "reviewer-thread-123456789");
    assert_eq!(
        implementer_dispatch.thread_id,
        "implementer-thread-123456789"
    );
    let (_, started_config) = processor
        .office_delegation_dispatch_mark_started(
            &cwd,
            reviewer_dispatch.config,
            &reviewer_dispatch.run_id,
            &reviewer_dispatch.delegation_id,
            "turn-reviewer",
        )
        .await
        .expect("mark stale reviewer config started");
    let delegations = started_config["workspace"]["activity"]["runs"][0]["delegations"]
        .as_array()
        .expect("delegations");
    assert_eq!(delegations.len(), 2);
    let reviewer = delegations
        .iter()
        .find(|delegation| {
            delegation.get("id").and_then(serde_json::Value::as_str)
                == Some(reviewer_dispatch.delegation_id.as_str())
        })
        .expect("reviewer delegation");
    let implementer = delegations
        .iter()
        .find(|delegation| {
            delegation.get("id").and_then(serde_json::Value::as_str)
                == Some(implementer_dispatch.delegation_id.as_str())
        })
        .expect("implementer delegation");
    assert_eq!(reviewer["status"], "running");
    assert_eq!(reviewer["turnId"], "turn-reviewer");
    assert_eq!(implementer["status"], "queued");
    assert_eq!(implementer["dispatchMethod"], "turnStart");
}

#[tokio::test]
async fn office_delegation_dispatch_next_auto_policy_skips_manual_and_high_risk() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    for agent in [
        json!({
            "agentId": "agent-reviewer",
            "name": "Reviewer",
            "threadId": "reviewer-thread-123456789",
            "role": "Code review"
        }),
        json!({
            "agentId": "agent-implementer",
            "name": "Implementer",
            "threadId": "implementer-thread-123456789",
            "role": "Implementation"
        }),
        json!({
            "agentId": "agent-verifier",
            "name": "Verifier",
            "threadId": "verifier-thread-123456789",
            "role": "Verification"
        }),
    ] {
        processor
            .agent_save(AgentSaveParams {
                cwd: cwd.clone(),
                config: agent,
            })
            .await
            .expect("save agent");
    }
    let prepared_run = processor
        .office_run_prepare(OfficeRunParams {
            cwd: cwd.clone(),
            config: json!({
                "title": "Platform Office",
                "workspace": {
                    "goal": "Ship the backend office",
                    "threadId": "office-thread-123456789",
                    "members": [
                        {
                            "name": "Reviewer",
                            "role": "Review final changes",
                            "status": "online",
                            "agentId": "agent-reviewer"
                        },
                        {
                            "name": "Implementer",
                            "role": "Implement final changes",
                            "status": "online",
                            "agentId": "agent-implementer"
                        },
                        {
                            "name": "Verifier",
                            "role": "Verify final changes",
                            "status": "online",
                            "agentId": "agent-verifier"
                        }
                    ],
                    "messages": [],
                    "tasks": [],
                    "activity": {
                        "approvals": [],
                        "artifacts": []
                    }
                }
            }),
            message: json!({
                "author": "User",
                "text": "Plan safe scheduler work"
            }),
            text: "Plan safe scheduler work".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare office run");
    let (_, started_config) = processor
        .office_run_mark_started(&cwd, prepared_run.config, &prepared_run.run_id, "turn-1")
        .await
        .expect("mark office run started");
    let planned = processor
        .office_run_sync(OfficeRunSyncParams {
            cwd: cwd.clone(),
            config: started_config,
            run_id: Some(prepared_run.run_id.clone()),
            turn: Turn {
                id: "turn-1".to_string(),
                items: vec![ThreadItem::AgentMessage {
                    id: "agent-message-1".to_string(),
                    text: r#"Planning.
```json
{
  "officeUpdate": {
    "summary": "Scheduler work planned.",
    "delegations": [
      {
        "member": "Reviewer",
        "agentId": "agent-reviewer",
        "task": "Review a risky migration before it runs",
        "status": "queued",
        "dispatchMode": "manual",
        "approvalRequired": true
      },
      {
        "member": "Implementer",
        "agentId": "agent-implementer",
        "task": "Apply the risky migration",
        "status": "queued",
        "riskSeverity": "high"
      },
      {
        "member": "Verifier",
        "agentId": "agent-verifier",
        "task": "Verify existing acceptance evidence",
        "status": "queued",
        "riskSeverity": "low"
      }
    ]
  }
}
```"#
                        .to_string(),
                    phase: None,
                    memory_citation: None,
                }],
                items_view: TurnItemsView::Full,
                status: TurnStatus::InProgress,
                error: None,
                started_at: Some(1),
                completed_at: None,
                duration_ms: None,
            },
            locale: Some("en".to_string()),
        })
        .await
        .expect("sync planned delegations");

    let interactive_dispatch = processor
        .office_delegation_dispatch_next_prepare(OfficeDelegationDispatchNextParams {
            cwd: cwd.clone(),
            config: planned.config.clone(),
            run_id: prepared_run.run_id.clone(),
            dispatch_policy: None,
            locale: Some("en".to_string()),
            client_user_message_id: Some("dispatch-interactive".to_string()),
        })
        .await
        .expect("interactive dispatch can claim the first manual task");
    assert_eq!(interactive_dispatch.thread_id, "reviewer-thread-123456789");
    let auto_dispatch = processor
        .office_delegation_dispatch_next_prepare(OfficeDelegationDispatchNextParams {
            cwd,
            config: planned.config,
            run_id: prepared_run.run_id,
            dispatch_policy: Some("auto".to_string()),
            locale: Some("en".to_string()),
            client_user_message_id: Some("dispatch-auto".to_string()),
        })
        .await
        .expect("auto dispatch skips manual and high-risk tasks");

    assert_eq!(auto_dispatch.thread_id, "verifier-thread-123456789");
    assert!(
        auto_dispatch
            .prompt
            .contains("Verify existing acceptance evidence")
    );
    let delegations = auto_dispatch.config["workspace"]["activity"]["runs"][0]["delegations"]
        .as_array()
        .expect("delegations");
    let safe_delegation = delegations
        .iter()
        .find(|delegation| {
            delegation.get("id").and_then(serde_json::Value::as_str)
                == Some(auto_dispatch.delegation_id.as_str())
        })
        .expect("safe delegation");
    assert_eq!(safe_delegation["riskSeverity"], "low");
    assert_eq!(safe_delegation["dispatchMethod"], "turnStart");
}

#[tokio::test]
async fn office_delegation_retry_creates_new_child_turn_from_failed_delegation() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    processor
        .agent_save(AgentSaveParams {
            cwd: cwd.clone(),
            config: json!({
                "agentId": "agent-reviewer",
                "name": "Reviewer",
                "threadId": "reviewer-thread-123456789",
                "role": "Code review"
            }),
        })
        .await
        .expect("save reviewer agent");
    let config = json!({
        "title": "Platform Office",
        "workspace": {
            "goal": "Ship the backend office",
            "threadId": "office-thread-123456789",
            "members": [{
                "name": "Reviewer",
                "role": "Review final changes",
                "status": "online",
                "agentId": "agent-reviewer",
                "runtime": {
                    "threadId": "reviewer-thread-123456789",
                    "contextPolicy": "sharedDigest",
                    "memoryScope": "privateAndShared"
                }
            }],
            "messages": [],
            "tasks": [],
            "activity": {
                "approvals": [],
                "artifacts": [],
                "runs": [{
                    "id": "office-run-1",
                    "title": "Review runtime state",
                    "status": "running",
                    "threadId": "office-thread-123456789",
                    "turnId": "manager-turn-1",
                    "delegations": [{
                        "id": "delegation-old",
                        "member": "Reviewer",
                        "agentId": "agent-reviewer",
                        "task": "Review runtime state",
                        "status": "failed",
                        "threadId": "reviewer-thread-123456789",
                        "target": "reviewer-thread-123456789",
                        "targetKind": "runtimeThread",
                        "tool": "followup_task",
                        "dispatchMethod": "turnStart",
                        "turnId": "turn-reviewer-old",
                        "error": "Tool approval timed out"
                    }]
                }]
            }
        }
    });
    processor
        .office_save(OfficeSaveParams {
            cwd: cwd.clone(),
            config: config.clone(),
        })
        .await
        .expect("save office");

    let prepared = processor
        .office_delegation_retry_prepare(OfficeDelegationRetryParams {
            cwd: cwd.clone(),
            config,
            run_id: "office-run-1".to_string(),
            delegation_id: "delegation-old".to_string(),
            locale: Some("en".to_string()),
            client_user_message_id: Some("retry-client-1".to_string()),
        })
        .await
        .expect("prepare delegation retry");

    assert_eq!(prepared.thread_id, "reviewer-thread-123456789");
    assert_eq!(
        prepared.retry_of_delegation_id.as_deref(),
        Some("delegation-old")
    );
    assert_ne!(prepared.delegation_id, "delegation-old");
    assert!(
        prepared
            .prompt
            .contains("Retry this delegated member task.")
    );
    assert!(
        prepared
            .prompt
            .contains("Previous turnId: turn-reviewer-old")
    );
    assert!(
        prepared
            .prompt
            .contains("Previous error: Tool approval timed out")
    );

    let delegations = prepared.config["workspace"]["activity"]["runs"][0]["delegations"]
        .as_array()
        .expect("delegations");
    assert_eq!(delegations.len(), 2);
    let retry = &delegations[0];
    let original = &delegations[1];
    assert_eq!(
        json!({
            "retryOf": retry["retryOf"].clone(),
            "member": retry["member"].clone(),
            "agentId": retry["agentId"].clone(),
            "task": retry["task"].clone(),
            "status": retry["status"].clone(),
            "threadId": retry["threadId"].clone(),
            "target": retry["target"].clone(),
            "targetKind": retry["targetKind"].clone(),
            "tool": retry["tool"].clone(),
            "dispatchMethod": retry["dispatchMethod"].clone()
        }),
        json!({
            "retryOf": "delegation-old",
            "member": "Reviewer",
            "agentId": "agent-reviewer",
            "task": "Review runtime state",
            "status": "queued",
            "threadId": "reviewer-thread-123456789",
            "target": "reviewer-thread-123456789",
            "targetKind": "runtimeThread",
            "tool": "followup_task",
            "dispatchMethod": "turnStart"
        })
    );
    assert_eq!(
        json!({
            "id": original["id"].clone(),
            "status": original["status"].clone(),
            "turnId": original["turnId"].clone(),
            "error": original["error"].clone()
        }),
        json!({
            "id": "delegation-old",
            "status": "failed",
            "turnId": "turn-reviewer-old",
            "error": "Tool approval timed out"
        })
    );

    let (_, started_config) = processor
        .office_delegation_dispatch_mark_started(
            &cwd,
            prepared.config.clone(),
            &prepared.run_id,
            &prepared.delegation_id,
            "turn-reviewer-retry",
        )
        .await
        .expect("mark retry started");
    let retry_delegation = &started_config["workspace"]["activity"]["runs"][0]["delegations"][0];
    assert_eq!(
        json!({
            "id": retry_delegation["id"].clone(),
            "retryOf": retry_delegation["retryOf"].clone(),
            "status": retry_delegation["status"].clone(),
            "turnId": retry_delegation["turnId"].clone()
        }),
        json!({
            "id": prepared.delegation_id,
            "retryOf": "delegation-old",
            "status": "running",
            "turnId": "turn-reviewer-retry"
        })
    );

    let duplicate_retry = processor
        .office_delegation_retry_prepare(OfficeDelegationRetryParams {
            cwd,
            config: started_config,
            run_id: "office-run-1".to_string(),
            delegation_id: "delegation-old".to_string(),
            locale: Some("en".to_string()),
            client_user_message_id: None,
        })
        .await
        .expect_err("active retry should block duplicate retry");
    assert_eq!(
        duplicate_retry.message,
        "office delegation retry is already active"
    );
}

#[tokio::test]
async fn office_delegation_dispatch_retrieves_scoped_long_term_memory() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    processor
        .agent_save(AgentSaveParams {
            cwd: cwd.clone(),
            config: json!({
                "agentId": "agent-reviewer",
                "name": "Reviewer",
                "threadId": "reviewer-thread-123456789",
                "role": "Code review"
            }),
        })
        .await
        .expect("save reviewer agent");
    let prepared_run = processor
        .office_run_prepare(OfficeRunParams {
            cwd: cwd.clone(),
            config: json!({
                "title": "Platform Office",
                "workspace": {
                    "goal": "Ship the backend office",
                    "threadId": "office-thread-123456789",
                    "members": [{
                        "name": "Reviewer",
                        "role": "Review final changes",
                        "status": "online",
                        "agentId": "agent-reviewer",
                        "runtime": {
                            "threadId": "reviewer-thread-123456789",
                            "contextPolicy": "sharedDigest",
                            "memoryScope": "privateAndShared"
                        }
                    }],
                    "messages": [],
                    "tasks": [],
                    "activity": {
                        "approvals": [],
                        "artifacts": []
                    }
                }
            }),
            message: json!({
                "author": "User",
                "text": "Record scoped memories"
            }),
            text: "Record scoped memories".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare office run");
    let (_, started_config) = processor
        .office_run_mark_started(&cwd, prepared_run.config, &prepared_run.run_id, "turn-1")
        .await
        .expect("mark office run started");
    let sync_response = processor
        .office_run_sync(OfficeRunSyncParams {
            cwd: cwd.clone(),
            config: started_config,
            run_id: Some(prepared_run.run_id.clone()),
            turn: Turn {
                id: "turn-1".to_string(),
                items: vec![ThreadItem::AgentMessage {
                    id: "agent-message-1".to_string(),
                    text: r#"Done.
```json
{
  "officeUpdate": {
    "summary": "Scoped memories recorded.",
    "memories": [
      {
        "scope": "office",
        "kind": "decision",
        "content": "Shared release reviews must cite verification evidence before completion.",
        "confidence": "high",
        "importance": "high",
        "status": "accepted"
      },
      {
        "scope": "member",
        "member": "Reviewer",
        "agentId": "agent-reviewer",
        "kind": "preference",
        "content": "Reviewer prefers reducer risks grouped by acceptance criterion.",
        "confidence": "high",
        "importance": "high",
        "status": "accepted"
      },
      {
        "scope": "member",
        "member": "Engineer",
        "agentId": "agent-engineer",
        "kind": "preference",
        "content": "Engineer private refactor notes must stay out of reviewer prompts.",
        "confidence": "high",
        "importance": "high",
        "status": "accepted"
      }
    ]
  }
}
```"#
                        .to_string(),
                    phase: None,
                    memory_citation: None,
                }],
                items_view: TurnItemsView::Full,
                status: TurnStatus::Completed,
                error: None,
                started_at: Some(1),
                completed_at: Some(2),
                duration_ms: Some(1_000),
            },
            locale: Some("en".to_string()),
        })
        .await
        .expect("sync scoped memory update");
    let candidate_memory_refs =
        sync_response.config["workspace"]["activity"]["runs"][0]["memoryRefs"]
            .as_array()
            .expect("candidate memory refs");
    assert_eq!(candidate_memory_refs.len(), 3);
    for memory_ref in candidate_memory_refs {
        assert_eq!(memory_ref["status"], "pending");
        assert_eq!(memory_ref["confidence"], "high");
        assert_eq!(memory_ref["importance"], "high");
        assert_eq!(memory_ref["evidenceRefs"][0]["turnId"], "turn-1");
    }
    let pending_memories = processor
        .office_memory_list(OfficeMemoryListParams {
            cwd: cwd.clone(),
            config: sync_response.config.clone(),
            status: Some("pending".to_string()),
            cursor: None,
            limit: None,
        })
        .await
        .expect("list pending memories");
    assert_eq!(pending_memories.data.len(), 3);
    let reviewer_memory_id = pending_memories
        .data
        .iter()
        .find(|memory| memory.content.starts_with("Reviewer prefers reducer risks"))
        .expect("reviewer memory")
        .id
        .clone();
    for memory in pending_memories.data {
        processor
            .office_memory_decide(OfficeMemoryDecideParams {
                cwd: cwd.clone(),
                config: sync_response.config.clone(),
                memory_id: memory.id,
                status: "accepted".to_string(),
            })
            .await
            .expect("accept memory");
    }

    let manager_prepared = processor
        .office_run_prepare(OfficeRunParams {
            cwd: cwd.clone(),
            config: sync_response.config.clone(),
            message: json!({
                "author": "User",
                "text": "Use scoped review memories"
            }),
            text: "Use scoped review memories".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare manager run with scoped memory");
    assert!(
        manager_prepared
            .prompt
            .contains("Shared release reviews must cite verification evidence")
    );
    assert!(
        !manager_prepared
            .prompt
            .contains("Reviewer prefers reducer risks")
    );
    assert!(
        !manager_prepared
            .prompt
            .contains("Engineer private refactor notes")
    );
    let manager_memory_refs =
        manager_prepared.config["workspace"]["activity"]["runs"][0]["memoryRefs"]
            .as_array()
            .expect("manager memory refs");
    assert_eq!(manager_memory_refs.len(), 1);
    assert_eq!(manager_memory_refs[0]["status"], "accepted");
    assert_eq!(manager_memory_refs[0]["confidence"], "high");
    assert_eq!(manager_memory_refs[0]["importance"], "high");
    assert_eq!(
        manager_memory_refs[0]["evidenceRefs"][0]["turnId"],
        "turn-1"
    );

    let prepared_dispatch = processor
        .office_delegation_dispatch_prepare(OfficeDelegationDispatchParams {
            cwd,
            config: sync_response.config,
            run_id: prepared_run.run_id.clone(),
            task: "Review reducer risks and verification evidence".to_string(),
            member: Some("Reviewer".to_string()),
            agent_id: None,
            locale: Some("en".to_string()),
            client_user_message_id: None,
        })
        .await
        .expect("prepare routed delegation dispatch with scoped memory");

    assert!(
        prepared_dispatch
            .prompt
            .contains("Shared release reviews must cite verification evidence")
    );
    assert!(
        prepared_dispatch
            .prompt
            .contains("Reviewer prefers reducer risks grouped by acceptance criterion")
    );
    assert!(
        !prepared_dispatch
            .prompt
            .contains("Engineer private refactor notes")
    );
    let run = prepared_dispatch.config["workspace"]["activity"]["runs"]
        .as_array()
        .expect("office runs")
        .iter()
        .find(|run| run.get("id").and_then(JsonValue::as_str) == Some(&prepared_run.run_id))
        .expect("original office run");
    let delegation = &run["delegations"][0];
    let memory_refs = delegation["memoryRefs"]
        .as_array()
        .expect("delegation memory refs");
    assert_eq!(memory_refs.len(), 2);
    for memory_ref in memory_refs {
        assert_eq!(memory_ref["status"], "accepted");
        assert_eq!(memory_ref["confidence"], "high");
        assert_eq!(memory_ref["importance"], "high");
        assert_eq!(memory_ref["evidenceRefs"][0]["turnId"], "turn-1");
    }

    processor
        .office_memory_decide(OfficeMemoryDecideParams {
            cwd: temp_dir.path().to_string_lossy().into_owned(),
            config: prepared_dispatch.config.clone(),
            memory_id: reviewer_memory_id,
            status: "rejected".to_string(),
        })
        .await
        .expect("reject reviewer memory");
    let read_response = processor
        .office_read(OfficeReadParams {
            cwd: temp_dir.path().to_string_lossy().into_owned(),
            thread_id: Some("office-thread-123456789".to_string()),
            title: None,
        })
        .await
        .expect("read office after memory rejection");
    let config = read_response.record.expect("office record").config;
    let run = config["workspace"]["activity"]["runs"]
        .as_array()
        .expect("saved runs")
        .iter()
        .find(|run| run.get("id").and_then(JsonValue::as_str) == Some(&prepared_run.run_id))
        .expect("saved run");
    let rejected_delegation_memory = run["delegations"][0]["memoryRefs"]
        .as_array()
        .expect("saved delegation memory refs")
        .iter()
        .find(|memory_ref| {
            memory_ref.get("content").and_then(JsonValue::as_str)
                == Some("Reviewer prefers reducer risks grouped by acceptance criterion.")
        })
        .expect("rejected delegation memory ref");
    assert_eq!(rejected_delegation_memory["status"], "rejected");
}

#[tokio::test]
async fn office_delegation_dispatch_applies_member_context_policy() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let config = json!({
        "title": "Platform Office",
        "workspace": {
            "goal": "Ship the backend office",
            "threadId": "office-thread-123456789",
            "members": [
                {
                    "name": "Reviewer",
                    "role": "Review release readiness",
                    "agentId": "agent-reviewer",
                    "runtime": {
                        "threadId": "reviewer-thread-123456789",
                        "contextPolicy": "sharedDigest",
                        "memoryScope": "privateAndShared"
                    }
                },
                {
                    "name": "Forker",
                    "role": "Use recent shared notes",
                    "agentId": "agent-forker",
                    "runtime": {
                        "threadId": "forker-thread-123456789",
                        "contextPolicy": "forkLastN",
                        "memoryScope": "shared"
                    }
                },
                {
                    "name": "Isolated",
                    "role": "Work from direct task only",
                    "agentId": "agent-isolated",
                    "runtime": {
                        "threadId": "isolated-thread-123456789",
                        "contextPolicy": "isolated",
                        "memoryScope": "shared"
                    }
                }
            ],
            "messages": [
                { "author": "User", "text": "Oldest shared context that should be omitted." },
                { "author": "Planner", "text": "Release notes need rollback wording." },
                { "author": "Verifier", "text": "Smoke test command is safe to run." },
                { "author": "Office", "text": "Focus on API coverage." },
                { "author": "User", "text": "Latest ship-room note: include acceptance evidence." }
            ],
            "tasks": [],
            "activity": {
                "approvals": [],
                "artifacts": [],
                "runs": [{
                    "id": "office-run-context",
                    "title": "Repair release readiness",
                    "status": "completed",
                    "threadId": "office-thread-123456789",
                    "requestText": "Repair release readiness",
                    "loop": {
                        "mode": "officeLoopEngineering",
                        "iteration": 2,
                        "maxIterations": 4,
                        "status": "continue",
                        "review": {
                            "status": "needsReview",
                            "nextAction": "runVerificationChecks"
                        }
                    },
                    "plan": [
                        { "step": "Confirm API coverage", "status": "inProgress" },
                        { "step": "Publish release notes", "status": "completed" }
                    ],
                    "acceptanceCriteria": [
                        { "criterion": "API coverage is documented", "status": "pending" }
                    ],
                    "verificationChecks": [
                        {
                            "check": "Run API smoke tests",
                            "status": "pending",
                            "command": "just test -p crewon-app-server api_smoke"
                        }
                    ],
                    "evidence": [
                        { "summary": "Smoke evidence is not collected", "status": "observed" }
                    ],
                    "risks": [
                        { "summary": "High-risk release without rollback notes", "severity": "high" }
                    ]
                }]
            }
        }
    });

    let shared = processor
        .office_delegation_dispatch_prepare(OfficeDelegationDispatchParams {
            cwd: cwd.clone(),
            config: config.clone(),
            run_id: "office-run-context".to_string(),
            task: "Review release context".to_string(),
            member: Some("Reviewer".to_string()),
            agent_id: None,
            locale: Some("en".to_string()),
            client_user_message_id: None,
        })
        .await
        .expect("prepare shared digest delegation");
    assert!(
        shared
            .prompt
            .contains("Shared Office digest (bounded, contextPolicy=sharedDigest")
    );
    assert!(
        shared
            .prompt
            .contains("Acceptance gap: API coverage is documented")
    );
    assert!(
        shared
            .prompt
            .contains("Verification check: Run API smoke tests")
    );
    assert!(
        shared
            .prompt
            .contains("just test -p crewon-app-server api_smoke")
    );
    assert!(
        shared
            .prompt
            .contains("Risk: High-risk release without rollback notes")
    );
    assert!(!shared.prompt.contains("Latest ship-room note"));

    let forked = processor
        .office_delegation_dispatch_prepare(OfficeDelegationDispatchParams {
            cwd: cwd.clone(),
            config: config.clone(),
            run_id: "office-run-context".to_string(),
            task: "Use recent notes".to_string(),
            member: Some("Forker".to_string()),
            agent_id: None,
            locale: Some("en".to_string()),
            client_user_message_id: None,
        })
        .await
        .expect("prepare forkLastN delegation");
    assert!(
        forked
            .prompt
            .contains("Shared Office digest (bounded, contextPolicy=forkLastN")
    );
    assert!(
        forked
            .prompt
            .contains("Recent message: User: Latest ship-room note")
    );
    assert!(
        !forked
            .prompt
            .contains("Oldest shared context that should be omitted")
    );

    let isolated = processor
        .office_delegation_dispatch_prepare(OfficeDelegationDispatchParams {
            cwd,
            config,
            run_id: "office-run-context".to_string(),
            task: "Do isolated review".to_string(),
            member: Some("Isolated".to_string()),
            agent_id: None,
            locale: Some("en".to_string()),
            client_user_message_id: None,
        })
        .await
        .expect("prepare isolated delegation");
    assert!(
        isolated
            .prompt
            .contains("Shared Office context: omitted by contextPolicy=isolated")
    );
    assert!(
        !isolated
            .prompt
            .contains("Acceptance gap: API coverage is documented")
    );
    assert!(!isolated.prompt.contains("Latest ship-room note"));
}

#[tokio::test]
async fn office_member_context_preview_applies_context_policy_without_dispatch() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let config = json!({
        "title": "Platform Office",
        "workspace": {
            "goal": "Ship the backend office",
            "threadId": "office-thread-123456789",
            "members": [
                {
                    "name": "Shared",
                    "role": "Review release readiness",
                    "agentId": "agent-shared",
                    "runtime": {
                        "threadId": "shared-thread-123456789",
                        "contextPolicy": "sharedDigest",
                        "memoryScope": "privateAndShared",
                        "agentProfile": "Release reviewer with API coverage focus."
                    }
                },
                {
                    "name": "Forker",
                    "role": "Use recent shared notes",
                    "agentId": "agent-forker",
                    "runtime": {
                        "threadId": "forker-thread-123456789",
                        "contextPolicy": "forkLastN",
                        "memoryScope": "shared"
                    }
                },
                {
                    "name": "Isolated",
                    "role": "Work from direct task only",
                    "agentId": "agent-isolated",
                    "runtime": {
                        "threadId": "isolated-thread-123456789",
                        "contextPolicy": "isolated",
                        "memoryScope": "shared"
                    }
                }
            ],
            "messages": [
                { "author": "User", "text": "Oldest shared context that should be omitted." },
                { "author": "Planner", "text": "Release notes need rollback wording." },
                { "author": "Verifier", "text": "Smoke test command is safe to run." },
                { "author": "Office", "text": "Focus on API coverage." },
                { "author": "User", "text": "Latest ship-room note: include acceptance evidence." }
            ],
            "activity": {
                "runs": [{
                    "id": "office-run-preview",
                    "title": "Repair release readiness",
                    "status": "completed",
                    "threadId": "office-thread-123456789",
                    "requestText": "Repair release readiness",
                    "loop": {
                        "status": "continue",
                        "review": {
                            "status": "needsReview",
                            "nextAction": "runVerificationChecks"
                        }
                    },
                    "acceptanceCriteria": [
                        { "criterion": "API coverage is documented", "status": "pending" }
                    ],
                    "verificationChecks": [
                        {
                            "check": "Run API smoke tests",
                            "status": "pending",
                            "command": "just test -p crewon-app-server api_smoke"
                        }
                    ],
                    "risks": [
                        { "summary": "High-risk release without rollback notes", "severity": "high" }
                    ],
                    "delegations": []
                }]
            }
        }
    });

    let shared = processor
        .office_member_context_preview(OfficeMemberContextPreviewParams {
            cwd: cwd.clone(),
            config: config.clone(),
            run_id: "office-run-preview".to_string(),
            task: Some("Review release context".to_string()),
            member: Some("Shared".to_string()),
            agent_id: None,
            locale: Some("en".to_string()),
        })
        .await
        .expect("preview shared context");
    assert_eq!(shared.thread_id, "shared-thread-123456789");
    assert_eq!(shared.context_policy, "sharedDigest");
    assert_eq!(
        shared.agent_profile,
        "Release reviewer with API coverage focus."
    );
    assert!(
        shared
            .shared_context
            .contains("Shared Office digest (bounded, contextPolicy=sharedDigest")
    );
    assert!(
        shared
            .shared_context
            .contains("Acceptance gap: API coverage is documented")
    );
    assert!(
        shared
            .shared_context
            .contains("Verification check: Run API smoke tests")
    );
    assert!(!shared.shared_context.contains("Latest ship-room note"));

    let forked = processor
        .office_member_context_preview(OfficeMemberContextPreviewParams {
            cwd: cwd.clone(),
            config: config.clone(),
            run_id: "office-run-preview".to_string(),
            task: None,
            member: Some("Forker".to_string()),
            agent_id: None,
            locale: Some("en".to_string()),
        })
        .await
        .expect("preview forkLastN context");
    assert_eq!(forked.context_policy, "forkLastN");
    assert!(
        forked
            .shared_context
            .contains("Shared Office digest (bounded, contextPolicy=forkLastN")
    );
    assert!(
        forked
            .shared_context
            .contains("Recent message: User: Latest ship-room note")
    );
    assert!(
        !forked
            .shared_context
            .contains("Oldest shared context that should be omitted")
    );

    let isolated = processor
        .office_member_context_preview(OfficeMemberContextPreviewParams {
            cwd,
            config,
            run_id: "office-run-preview".to_string(),
            task: Some("Do isolated review".to_string()),
            member: Some("Isolated".to_string()),
            agent_id: None,
            locale: Some("en".to_string()),
        })
        .await
        .expect("preview isolated context");
    assert_eq!(isolated.context_policy, "isolated");
    assert!(
        isolated
            .shared_context
            .contains("Shared Office context: omitted by contextPolicy=isolated")
    );
    assert!(
        !isolated
            .shared_context
            .contains("Acceptance gap: API coverage is documented")
    );
    assert!(
        isolated
            .memory_context
            .contains("Member task long-term memories: no accepted memories")
    );
}

async fn prepare_started_member_delegation(
    processor: &CrewonDomainRequestProcessor,
    cwd: &str,
    task: &str,
) -> (String, JsonValue) {
    processor
        .agent_save(AgentSaveParams {
            cwd: cwd.to_string(),
            config: json!({
                "agentId": "agent-reviewer",
                "name": "Reviewer",
                "threadId": "reviewer-thread-123456789",
                "role": "Code review"
            }),
        })
        .await
        .expect("save reviewer agent");
    let prepared_run = processor
        .office_run_prepare(OfficeRunParams {
            cwd: cwd.to_string(),
            config: json!({
                "title": "Platform Office",
                "workspace": {
                    "goal": "Ship the backend office",
                    "threadId": "office-thread-123456789",
                    "members": [{
                        "name": "Reviewer",
                        "role": "Review final changes",
                        "status": "online",
                        "agentId": "agent-reviewer"
                    }],
                    "messages": [],
                    "tasks": [],
                    "activity": {
                        "approvals": [],
                        "artifacts": []
                    }
                }
            }),
            message: json!({
                "author": "User",
                "text": "Dispatch a member review"
            }),
            text: "Dispatch a member review".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare office run");
    let (_, started_run_config) = processor
        .office_run_mark_started(
            cwd,
            prepared_run.config,
            &prepared_run.run_id,
            "turn-manager-1",
        )
        .await
        .expect("mark office run started");
    let prepared_dispatch = processor
        .office_delegation_dispatch_prepare(OfficeDelegationDispatchParams {
            cwd: cwd.to_string(),
            config: started_run_config,
            run_id: prepared_run.run_id.clone(),
            task: task.to_string(),
            member: Some("Reviewer".to_string()),
            agent_id: None,
            locale: Some("en".to_string()),
            client_user_message_id: None,
        })
        .await
        .expect("prepare member dispatch");
    let (_, started_delegation_config) = processor
        .office_delegation_dispatch_mark_started(
            cwd,
            prepared_dispatch.config,
            &prepared_run.run_id,
            &prepared_dispatch.delegation_id,
            "turn-delegation-1",
        )
        .await
        .expect("mark delegation started");

    (prepared_run.run_id, started_delegation_config)
}

#[tokio::test]
async fn office_run_sync_reconciles_member_delegation_turn() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    processor
        .agent_save(AgentSaveParams {
            cwd: cwd.clone(),
            config: json!({
                "agentId": "agent-reviewer",
                "name": "Reviewer",
                "threadId": "reviewer-thread-123456789",
                "role": "Code review"
            }),
        })
        .await
        .expect("save reviewer agent");
    let prepared_run = processor
        .office_run_prepare(OfficeRunParams {
            cwd: cwd.clone(),
            config: json!({
                "title": "Platform Office",
                "workspace": {
                    "goal": "Ship the backend office",
                    "threadId": "office-thread-123456789",
                    "members": [{
                        "name": "Reviewer",
                        "role": "Review final changes",
                        "status": "online",
                        "agentId": "agent-reviewer"
                    }],
                    "messages": [],
                    "tasks": [],
                    "activity": {
                        "approvals": [],
                        "artifacts": []
                    }
                }
            }),
            message: json!({
                "author": "User",
                "text": "Dispatch a member review"
            }),
            text: "Dispatch a member review".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare office run");
    let (_, started_run_config) = processor
        .office_run_mark_started(
            &cwd,
            prepared_run.config,
            &prepared_run.run_id,
            "turn-manager-1",
        )
        .await
        .expect("mark office run started");
    let prepared_dispatch = processor
        .office_delegation_dispatch_prepare(OfficeDelegationDispatchParams {
            cwd: cwd.clone(),
            config: started_run_config,
            run_id: prepared_run.run_id.clone(),
            task: "Review member sync behavior".to_string(),
            member: Some("Reviewer".to_string()),
            agent_id: None,
            locale: Some("en".to_string()),
            client_user_message_id: None,
        })
        .await
        .expect("prepare member dispatch");
    let (_, started_delegation_config) = processor
        .office_delegation_dispatch_mark_started(
            &cwd,
            prepared_dispatch.config,
            &prepared_run.run_id,
            &prepared_dispatch.delegation_id,
            "turn-delegation-1",
        )
        .await
        .expect("mark delegation started");

    let sync_response = processor
        .office_run_sync(OfficeRunSyncParams {
            cwd,
            config: started_delegation_config,
            run_id: Some(prepared_run.run_id),
            turn: Turn {
                id: "turn-delegation-1".to_string(),
                items: vec![ThreadItem::AgentMessage {
                    id: "agent-message-1".to_string(),
                    text: "Member review completed with evidence.".to_string(),
                    phase: None,
                    memory_citation: None,
                }],
                items_view: TurnItemsView::Full,
                status: TurnStatus::Completed,
                error: None,
                started_at: Some(1),
                completed_at: Some(2),
                duration_ms: Some(1_000),
            },
            locale: Some("en".to_string()),
        })
        .await
        .expect("sync member delegation turn through office run sync");

    let run = &sync_response.config["workspace"]["activity"]["runs"][0];
    assert_eq!(run["turnId"], "turn-manager-1");
    let delegation = &run["delegations"][0];
    assert_eq!(delegation["status"], "completed");
    assert_eq!(delegation["threadId"], "reviewer-thread-123456789");
    assert_eq!(
        delegation["resultPreview"],
        "Member review completed with evidence."
    );
}

#[tokio::test]
async fn office_run_sync_marks_failed_member_delegation_retryable() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let task = "Review failure handling";
    let (run_id, started_delegation_config) =
        prepare_started_member_delegation(&processor, &cwd, task).await;

    let sync_response = processor
        .office_run_sync(OfficeRunSyncParams {
            cwd,
            config: started_delegation_config,
            run_id: Some(run_id.clone()),
            turn: Turn {
                id: "turn-delegation-1".to_string(),
                items: Vec::new(),
                items_view: TurnItemsView::Full,
                status: TurnStatus::Failed,
                error: Some(TurnError {
                    message: "review command failed".to_string(),
                    codex_error_info: None,
                    additional_details: None,
                }),
                started_at: Some(1),
                completed_at: Some(2),
                duration_ms: Some(1_000),
            },
            locale: Some("en".to_string()),
        })
        .await
        .expect("sync failed member delegation turn");

    let workspace = &sync_response.config["workspace"];
    let run = &workspace["activity"]["runs"][0];
    let delegation = &run["delegations"][0];
    assert_eq!(run["turnId"], "turn-manager-1");
    assert_eq!(delegation["status"], "failed");
    assert_eq!(delegation["error"], "review command failed");
    assert_eq!(delegation["threadId"], "reviewer-thread-123456789");
    assert_eq!(workspace["tasks"][0]["title"], task);
    assert_eq!(workspace["tasks"][0]["status"], "todo");
    assert_eq!(workspace["tasks"][0]["runId"], run_id);
    assert!(
        workspace["messages"]
            .as_array()
            .expect("messages")
            .iter()
            .any(|message| message
                .get("text")
                .and_then(|text| text.as_str())
                .is_some_and(|text| text.contains("Member Reviewer delegation failed")
                    && text.contains("review command failed")))
    );
}

#[tokio::test]
async fn office_run_sync_marks_interrupted_member_delegation_retryable() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let task = "Review interruption handling";
    let (run_id, started_delegation_config) =
        prepare_started_member_delegation(&processor, &cwd, task).await;

    let sync_response = processor
        .office_run_sync(OfficeRunSyncParams {
            cwd,
            config: started_delegation_config,
            run_id: Some(run_id.clone()),
            turn: Turn {
                id: "turn-delegation-1".to_string(),
                items: Vec::new(),
                items_view: TurnItemsView::Full,
                status: TurnStatus::Interrupted,
                error: None,
                started_at: Some(1),
                completed_at: Some(2),
                duration_ms: Some(1_000),
            },
            locale: Some("en".to_string()),
        })
        .await
        .expect("sync interrupted member delegation turn");

    let workspace = &sync_response.config["workspace"];
    let run = &workspace["activity"]["runs"][0];
    let delegation = &run["delegations"][0];
    assert_eq!(run["turnId"], "turn-manager-1");
    assert_eq!(delegation["status"], "interrupted");
    assert!(delegation.get("error").is_none());
    assert_eq!(delegation["threadId"], "reviewer-thread-123456789");
    assert_eq!(workspace["tasks"][0]["title"], task);
    assert_eq!(workspace["tasks"][0]["status"], "todo");
    assert_eq!(workspace["tasks"][0]["runId"], run_id);
    assert!(
        workspace["messages"]
            .as_array()
            .expect("messages")
            .iter()
            .any(|message| message
                .get("text")
                .and_then(|text| text.as_str())
                .is_some_and(
                    |text| text.contains("Member Reviewer delegation interrupted")
                        && text.contains(task)
                ))
    );
}

#[tokio::test]
async fn office_delegation_auto_sync_reduces_member_turn_into_parent_run() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    processor
        .agent_save(AgentSaveParams {
            cwd: cwd.clone(),
            config: json!({
                "agentId": "agent-reviewer",
                "name": "Reviewer",
                "threadId": "reviewer-thread-123456789",
                "role": "Code review"
            }),
        })
        .await
        .expect("save reviewer agent");
    let prepared_run = processor
        .office_run_prepare(OfficeRunParams {
            cwd: cwd.clone(),
            config: json!({
                "title": "Platform Office",
                "workspace": {
                    "goal": "Ship the backend office",
                    "threadId": "office-thread-123456789",
                    "members": [{
                        "name": "Reviewer",
                        "role": "Review final changes",
                        "status": "online",
                        "agentId": "agent-reviewer"
                    }],
                    "messages": [],
                    "tasks": [],
                    "activity": {
                        "approvals": [],
                        "artifacts": []
                    }
                }
            }),
            message: json!({
                "author": "User",
                "text": "Ship routed dispatch"
            }),
            text: "Ship routed dispatch".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare office run");
    let (_, started_config) = processor
        .office_run_mark_started(
            &cwd,
            prepared_run.config,
            &prepared_run.run_id,
            "turn-office-1",
        )
        .await
        .expect("mark office run started");
    let prepared_dispatch = processor
        .office_delegation_dispatch_prepare(OfficeDelegationDispatchParams {
            cwd: cwd.clone(),
            config: started_config,
            run_id: prepared_run.run_id.clone(),
            task: "Review the deterministic dispatch adapter".to_string(),
            member: None,
            agent_id: Some("agent-reviewer".to_string()),
            locale: Some("en".to_string()),
            client_user_message_id: None,
        })
        .await
        .expect("prepare routed delegation dispatch");
    processor
        .office_delegation_dispatch_mark_started(
            &cwd,
            prepared_dispatch.config,
            &prepared_run.run_id,
            &prepared_dispatch.delegation_id,
            "turn-delegation-1",
        )
        .await
        .expect("mark delegation started");

    let completed_turn = Turn {
        id: "turn-delegation-1".to_string(),
        items: vec![ThreadItem::AgentMessage {
            id: "agent-message-1".to_string(),
            text: r#"Reviewer verified the dispatch adapter and found no blockers.
```json
{
  "officeUpdate": {
    "summary": "Reviewer verified the dispatch adapter and found no blockers.",
    "goalUpdate": "Do not let member turns own the office goal",
    "acceptanceCriteria": [
      { "criterion": "Delegation reducer preserves parent run status", "status": "passed", "evidence": "Parent run stayed running" }
    ],
    "evidence": [
      { "summary": "Reviewer checked the reducer path", "status": "verified", "source": "reviewer-thread" }
    ],
    "risks": [
      { "summary": "Member results could hide parent blockers", "severity": "medium", "mitigation": "Manager run remains authoritative" }
    ],
    "tasks": [
      {
        "title": "Document delegation reducer behavior",
        "owner": "Reviewer",
        "status": "done"
      }
    ],
    "artifacts": [
      {
        "title": "delegation-review.md",
        "kind": "doc",
        "meta": "Reviewer notes from member runtime"
      }
    ],
    "memories": [
      {
        "scope": "office",
        "kind": "lesson",
        "content": "Member delegation results should merge bounded summaries, not private transcripts.",
        "confidence": "high",
        "importance": "high",
        "status": "accepted"
      }
    ]
  }
}
```"#
            .to_string(),
            phase: None,
            memory_citation: None,
        }],
        items_view: TurnItemsView::Full,
        status: TurnStatus::Completed,
        error: None,
        started_at: Some(1),
        completed_at: Some(2),
        duration_ms: Some(1_000),
    };

    let synced =
        sync_office_runs_for_thread_turn(&cwd, "reviewer-thread-123456789", &completed_turn)
            .await
            .expect("auto sync member delegation");
    let synced_again =
        sync_office_runs_for_thread_turn(&cwd, "reviewer-thread-123456789", &completed_turn)
            .await
            .expect("auto sync member delegation again");
    let read_response = processor
        .office_read(OfficeReadParams {
            cwd: cwd.clone(),
            thread_id: Some("office-thread-123456789".to_string()),
            title: None,
        })
        .await
        .expect("read office config");
    let config = read_response.record.expect("office record").config;
    let delegation = &config["workspace"]["activity"]["runs"][0]["delegations"][0];

    assert_eq!(synced, 1);
    assert_eq!(synced_again, 1);
    assert_eq!(
        config["workspace"]["activity"]["runs"][0]["status"],
        "running"
    );
    assert_eq!(config["workspace"]["goal"], "Ship the backend office");
    assert_eq!(delegation["status"], "completed");
    assert_eq!(
        delegation["resultPreview"],
        "Reviewer verified the dispatch adapter and found no blockers."
    );
    assert_eq!(
        config["workspace"]["activity"]["runs"][0]["acceptanceCriteria"][0]["member"],
        "Reviewer"
    );
    assert_eq!(
        config["workspace"]["activity"]["runs"][0]["acceptanceCriteria"][0]["status"],
        "passed"
    );
    assert_eq!(
        config["workspace"]["activity"]["runs"][0]["evidence"][0]["delegationId"],
        prepared_dispatch.delegation_id
    );
    assert_eq!(
        config["workspace"]["activity"]["runs"][0]["risks"][0]["severity"],
        "medium"
    );
    let tasks = config["workspace"]["tasks"].as_array().expect("tasks");
    assert!(tasks.iter().any(|task| {
        task.get("title").and_then(|title| title.as_str())
            == Some("Review the deterministic dispatch adapter")
            && task.get("status").and_then(|status| status.as_str()) == Some("done")
            && task.get("owner").and_then(|owner| owner.as_str()) == Some("Reviewer")
    }));
    assert!(tasks.iter().any(|task| {
        task.get("title").and_then(|title| title.as_str())
            == Some("Document delegation reducer behavior")
            && task.get("status").and_then(|status| status.as_str()) == Some("done")
            && task.get("owner").and_then(|owner| owner.as_str()) == Some("Reviewer")
    }));
    let artifacts = config["workspace"]["activity"]["artifacts"]
        .as_array()
        .expect("artifacts");
    assert!(artifacts.iter().any(|artifact| {
        artifact.get("title").and_then(|title| title.as_str()) == Some("delegation-review.md")
            && artifact.get("meta").and_then(|meta| meta.as_str())
                == Some("Reviewer notes from member runtime")
    }));
    let memory_refs = config["workspace"]["activity"]["runs"][0]["memoryRefs"]
        .as_array()
        .expect("run memory refs");
    assert_eq!(memory_refs.len(), 1);
    assert_eq!(memory_refs[0]["kind"], "lesson");
    let sync_messages = config["workspace"]["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .filter(|message| {
            message.get("event").and_then(|event| event.as_str()) == Some("delegationSync")
        })
        .count();
    assert_eq!(sync_messages, 1);
    let memory_index_path = temp_dir
        .path()
        .join(".crewon")
        .join("office-memory")
        .join("index.json");
    let memory_index = std::fs::read_to_string(memory_index_path).expect("read memory index");
    let memory_index: serde_json::Value =
        serde_json::from_str(&memory_index).expect("parse memory index");
    assert_eq!(
        memory_index["memories"][0]["content"],
        "Member delegation results should merge bounded summaries, not private transcripts."
    );
    assert_eq!(
        memory_index["memories"][0]["evidenceRefs"][0]["turnId"],
        "turn-delegation-1"
    );
}

#[tokio::test]
async fn office_run_prepare_rejects_unbound_office() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();

    let error = processor
        .office_run_prepare(OfficeRunParams {
            cwd: temp_dir.path().to_string_lossy().into_owned(),
            config: json!({
                "title": "Platform Office",
                "workspace": {
                    "goal": "Ship",
                    "messages": [],
                    "tasks": []
                }
            }),
            message: json!({
                "author": "User",
                "text": "Run this"
            }),
            text: "Run this".to_string(),
            locale: None,
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect_err("unbound office should fail");

    assert_eq!(error.code, INVALID_PARAMS_ERROR_CODE);
    assert_eq!(
        error.message,
        "office workspace must be bound to a threadId before it can run".to_string()
    );
}

#[tokio::test]
async fn office_run_mark_failed_makes_task_retryable() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let prepared = processor
        .office_run_prepare(OfficeRunParams {
            cwd: cwd.clone(),
            config: json!({
                "title": "Platform Office",
                "workspace": {
                    "goal": "Ship the backend office",
                    "threadId": "office-thread-123456789",
                    "members": [{
                        "name": "Reviewer",
                        "role": "Review final changes",
                        "status": "online",
                        "agentId": "agent-reviewer"
                    }],
                    "messages": [],
                    "tasks": [],
                    "activity": {
                        "approvals": [],
                        "artifacts": []
                    }
                }
            }),
            message: json!({
                "author": "User",
                "text": "Run this"
            }),
            text: "Run this".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare office run");

    processor
        .office_run_mark_failed(&cwd, prepared.config, &prepared.run_id, "thread not found")
        .await
        .expect("mark office run failed");
    let read_response = processor
        .office_read(OfficeReadParams {
            cwd,
            thread_id: Some("office-thread-123456789".to_string()),
            title: None,
        })
        .await
        .expect("read office config");
    let config = read_response.record.expect("office record").config;

    assert_eq!(
        config["workspace"]["activity"]["runs"][0]["status"],
        "failed"
    );
    assert_eq!(
        config["workspace"]["activity"]["runs"][0]["error"],
        "thread not found"
    );
    assert_eq!(config["workspace"]["tasks"][0]["status"], "todo");
}

#[tokio::test]
async fn office_run_sync_marks_completed_run_and_is_idempotent() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let config = json!({
        "title": "Platform Office",
        "workspace": {
            "goal": "Ship the backend office",
            "threadId": "office-thread-123456789",
            "messages": [],
            "tasks": [],
            "activity": {
                "approvals": [],
                "artifacts": []
            }
        }
    });

    let prepared = processor
        .office_run_prepare(OfficeRunParams {
            cwd: cwd.clone(),
            config,
            message: json!({
                "author": "User",
                "glyph": "@",
                "accent": "slate",
                "time": "09:10",
                "kind": "message",
                "text": "Finish office sync"
            }),
            text: "Finish office sync".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare office run");
    assert!(prepared.prompt.contains("officeUpdate"));
    let (_, started_config) = processor
        .office_run_mark_started(&cwd, prepared.config, &prepared.run_id, "turn-1")
        .await
        .expect("mark office run started");
    let completed_turn = Turn {
        id: "turn-1".to_string(),
        items: vec![ThreadItem::AgentMessage {
            id: "agent-message-1".to_string(),
            text: "Office sync is implemented and verified.".to_string(),
            phase: None,
            memory_citation: None,
        }],
        items_view: TurnItemsView::Full,
        status: TurnStatus::Completed,
        error: None,
        started_at: Some(1),
        completed_at: Some(2),
        duration_ms: Some(1_000),
    };

    let sync_response = processor
        .office_run_sync(OfficeRunSyncParams {
            cwd: cwd.clone(),
            config: started_config,
            run_id: Some(prepared.run_id.clone()),
            turn: completed_turn.clone(),
            locale: Some("en".to_string()),
        })
        .await
        .expect("sync completed office run");
    let sync_again_response = processor
        .office_run_sync(OfficeRunSyncParams {
            cwd: cwd.clone(),
            config: sync_response.config.clone(),
            run_id: None,
            turn: completed_turn,
            locale: Some("en".to_string()),
        })
        .await
        .expect("sync completed office run again");
    let read_response = processor
        .office_read(OfficeReadParams {
            cwd,
            thread_id: Some("office-thread-123456789".to_string()),
            title: None,
        })
        .await
        .expect("read office config");

    assert_eq!(
        sync_again_response.config["workspace"]["activity"]["runs"][0]["status"],
        "completed"
    );
    assert_eq!(
        sync_again_response.config["workspace"]["activity"]["runs"][0]["resultPreview"],
        "Office sync is implemented and verified."
    );
    assert_eq!(
        sync_again_response.config["workspace"]["tasks"][0]["status"],
        "done"
    );
    let sync_messages = sync_again_response.config["workspace"]["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .filter(|message| message.get("event").and_then(|event| event.as_str()) == Some("runSync"))
        .count();
    assert_eq!(sync_messages, 1);
    assert_eq!(
        read_response.record.expect("office record").config,
        sync_again_response.config
    );
}

#[tokio::test]
async fn office_run_sync_preserves_latest_persisted_office_record() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let config = json!({
        "title": "Platform Office",
        "workspace": {
            "goal": "Ship the backend office",
            "threadId": "office-thread-123456789",
            "messages": [],
            "tasks": [],
            "activity": {
                "approvals": [],
                "artifacts": []
            }
        }
    });

    let prepared = processor
        .office_run_prepare(OfficeRunParams {
            cwd: cwd.clone(),
            config,
            message: json!({
                "author": "User",
                "glyph": "@",
                "accent": "slate",
                "time": "09:10",
                "kind": "message",
                "text": "Finish office sync"
            }),
            text: "Finish office sync".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare office run");
    let (_, stale_started_config) = processor
        .office_run_mark_started(&cwd, prepared.config, &prepared.run_id, "turn-1")
        .await
        .expect("mark office run started");
    let mut latest_config = stale_started_config.clone();
    latest_config["workspace"]["activity"]["artifacts"] = json!([
        {
            "title": "Delivery Plan",
            "kind": "doc",
            "glyph": "D",
            "accent": "blue",
            "meta": "fresh"
        }
    ]);
    processor
        .office_save(OfficeSaveParams {
            cwd: cwd.clone(),
            config: latest_config.clone(),
        })
        .await
        .expect("save newer office config");

    let sync_response = processor
        .office_run_sync(OfficeRunSyncParams {
            cwd,
            config: stale_started_config,
            run_id: Some(prepared.run_id),
            turn: Turn {
                id: "turn-1".to_string(),
                items: vec![ThreadItem::AgentMessage {
                    id: "agent-message-1".to_string(),
                    text: "Office sync is implemented and verified.".to_string(),
                    phase: None,
                    memory_citation: None,
                }],
                items_view: TurnItemsView::Full,
                status: TurnStatus::Completed,
                error: None,
                started_at: Some(1),
                completed_at: Some(2),
                duration_ms: Some(1_000),
            },
            locale: Some("en".to_string()),
        })
        .await
        .expect("sync completed office run");

    assert_eq!(
        sync_response.config["workspace"]["activity"]["artifacts"],
        latest_config["workspace"]["activity"]["artifacts"]
    );
    assert_eq!(
        sync_response.config["workspace"]["activity"]["runs"][0]["status"],
        "completed"
    );
}

#[tokio::test]
async fn office_run_sync_applies_structured_update_plan_goal_and_delegations() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let prepared = processor
        .office_run_prepare(OfficeRunParams {
            cwd: cwd.clone(),
            config: json!({
                "title": "Platform Office",
                "workspace": {
                    "goal": "Ship the backend office",
                    "threadId": "office-thread-123456789",
                    "members": [{
                        "name": "Reviewer",
                        "role": "Review final changes",
                        "status": "online",
                        "agentId": "agent-reviewer"
                    }],
                    "messages": [],
                    "tasks": [],
                    "activity": {
                        "approvals": [],
                        "artifacts": []
                    }
                }
            }),
            message: json!({
                "author": "User",
                "text": "Finish structured reducer"
            }),
            text: "Finish structured reducer".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare office run");
    assert!(prepared.prompt.contains("agentId=agent-reviewer"));
    assert!(prepared.prompt.contains("officeUpdate"));
    let (_, started_config) = processor
        .office_run_mark_started(&cwd, prepared.config, &prepared.run_id, "turn-1")
        .await
        .expect("mark office run started");

    let sync_response = processor
        .office_run_sync(OfficeRunSyncParams {
            cwd: cwd.clone(),
            config: started_config,
            run_id: Some(prepared.run_id.clone()),
            turn: Turn {
                id: "turn-1".to_string(),
                items: vec![
                    ThreadItem::Plan {
                        id: "plan-1".to_string(),
                        text: "- [completed] Inspect state\n- [inProgress] Wire reducer"
                            .to_string(),
                    },
                    ThreadItem::AgentMessage {
                        id: "agent-message-1".to_string(),
                        text: r#"Done.
```json
{
  "officeUpdate": {
    "summary": "Structured reducer finished.",
    "goalUpdate": "Ship the backend office with structured runs",
    "acceptanceCriteria": [
      { "criterion": "Office run exposes verified state", "status": "passed", "evidence": "Reducer assertions passed" }
    ],
    "evidence": [
      { "summary": "Reducer parsed structured officeUpdate", "status": "verified", "source": "turn-1" }
    ],
    "risks": [
      { "summary": "Reducer can overwrite unrelated state", "severity": "low", "mitigation": "Latest persisted config is used" }
    ],
    "tasks": [
      { "title": "Implement reducer", "owner": "Engineer", "status": "done" }
    ],
    "artifacts": [
      { "title": "Reducer Notes", "kind": "doc", "glyph": "D", "accent": "green", "meta": "ready" }
    ],
    "delegations": [
      { "member": "Engineer", "agentId": "agent-engineer", "task": "Reducer", "status": "completed", "threadId": "thread-sub" }
    ]
  }
}
```"#
                        .to_string(),
                        phase: None,
                        memory_citation: None,
                    },
                ],
                items_view: TurnItemsView::Full,
                status: TurnStatus::Completed,
                error: None,
                started_at: Some(1),
                completed_at: Some(2),
                duration_ms: Some(1_000),
            },
            locale: Some("en".to_string()),
        })
        .await
        .expect("sync structured office run");
    let config = sync_response.config;

    assert_eq!(
        config["workspace"]["goal"],
        "Ship the backend office with structured runs"
    );
    assert_eq!(
        config["workspace"]["activity"]["runs"][0]["resultPreview"],
        "Structured reducer finished."
    );
    assert_eq!(
        config["workspace"]["activity"]["runs"][0]["acceptanceCriteria"][0]["status"],
        "passed"
    );
    assert_eq!(
        config["workspace"]["activity"]["runs"][0]["evidence"][0]["summary"],
        "Reducer parsed structured officeUpdate"
    );
    assert_eq!(
        config["workspace"]["activity"]["runs"][0]["evidence"][0]["status"],
        "observed"
    );
    assert_eq!(
        config["workspace"]["activity"]["runs"][0]["risks"][0]["severity"],
        "low"
    );
    assert_eq!(
        config["workspace"]["activity"]["runs"][0]["loop"]["review"],
        json!({
            "status": "needsReview",
            "nextAction": "collectVerificationEvidence",
            "acceptance": {
                "total": 1,
                "passed": 1,
                "failed": 0,
                "pending": 0
            },
            "verification": {
                "total": 0,
                "passed": 0,
                "failed": 0,
                "pending": 0,
                "runnablePending": 0,
                "missingRunnablePending": 0
            },
            "evidence": {
                "total": 1,
                "verified": 0,
                "blocked": 0
            },
            "risks": {
                "total": 1,
                "high": 0,
                "openHigh": 0
            },
            "updatedAt": config["workspace"]["activity"]["runs"][0]["loop"]["review"]["updatedAt"]
        })
    );
    assert_eq!(
        config["workspace"]["activity"]["runs"][0]["plan"][0],
        json!({ "step": "[completed] Inspect state", "status": "completed" })
    );
    assert_eq!(
        config["workspace"]["activity"]["runs"][0]["delegations"][0]["agentId"],
        "agent-engineer"
    );
    assert_eq!(
        config["workspace"]["activity"]["artifacts"][0]["title"],
        "Reducer Notes"
    );
    assert_eq!(
        config["workspace"]["tasks"]
            .as_array()
            .expect("tasks")
            .iter()
            .find(|task| task.get("title").and_then(|title| title.as_str())
                == Some("Implement reducer"))
            .expect("structured task")["status"],
        "done"
    );
}

#[tokio::test]
async fn office_run_loop_review_marks_blocked_verification() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let prepared = processor
        .office_run_prepare(OfficeRunParams {
            cwd: cwd.clone(),
            config: json!({
                "title": "Platform Office",
                "workspace": {
                    "goal": "Ship the backend office",
                    "threadId": "office-thread-123456789",
                    "messages": [],
                    "tasks": [],
                    "activity": {
                        "approvals": [],
                        "artifacts": []
                    }
                }
            }),
            message: json!({
                "author": "User",
                "text": "Check release readiness"
            }),
            text: "Check release readiness".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare office run");
    let (_, started_config) = processor
        .office_run_mark_started(&cwd, prepared.config, &prepared.run_id, "turn-1")
        .await
        .expect("mark office run started");

    let sync_response = processor
        .office_run_sync(OfficeRunSyncParams {
            cwd: cwd.clone(),
            config: started_config,
            run_id: Some(prepared.run_id.clone()),
            turn: Turn {
                id: "turn-1".to_string(),
                items: vec![ThreadItem::AgentMessage {
                    id: "agent-message-1".to_string(),
                    text: r#"Blocked.
```json
{
  "officeUpdate": {
    "summary": "Release readiness is blocked.",
    "acceptanceCriteria": [
      { "criterion": "All checks pass", "status": "failed", "evidence": "Integration test failed" },
      { "criterion": "Rollback plan is documented", "status": "pending" }
    ],
    "verificationChecks": [
      { "check": "Run integration suite", "status": "failed", "command": "just test -p crewon-app-server", "evidence": "suite failed" },
      { "check": "Run smoke automation", "status": "pending", "automationId": "nightly-smoke" }
    ],
    "evidence": [
      { "summary": "Integration test failed", "status": "blocked", "source": "just test" }
    ],
    "risks": [
      { "summary": "Release could regress users", "severity": "high" }
    ]
  }
}
```"#
                        .to_string(),
                    phase: None,
                    memory_citation: None,
                }],
                items_view: TurnItemsView::Full,
                status: TurnStatus::Completed,
                error: None,
                started_at: Some(1),
                completed_at: Some(2),
                duration_ms: Some(1_000),
            },
            locale: Some("en".to_string()),
        })
        .await
        .expect("sync blocked office run");

    let review = &sync_response.config["workspace"]["activity"]["runs"][0]["loop"]["review"];
    assert_eq!(
        review,
        &json!({
            "status": "blocked",
            "nextAction": "repairFailedCriteria",
            "acceptance": {
                "total": 2,
                "passed": 0,
                "failed": 1,
                "pending": 1
            },
            "verification": {
                "total": 2,
                "passed": 0,
                "failed": 1,
                "pending": 1,
                "runnablePending": 1,
                "missingRunnablePending": 0
            },
            "evidence": {
                "total": 1,
                "verified": 0,
                "blocked": 1
            },
            "risks": {
                "total": 1,
                "high": 1,
                "openHigh": 1
            },
            "updatedAt": review["updatedAt"]
        })
    );
    assert_eq!(
        sync_response.config["workspace"]["activity"]["runs"][0]["verificationChecks"][0],
        json!({
            "check": "Run integration suite",
            "status": "failed",
            "command": "just test -p crewon-app-server",
            "evidence": "suite failed",
            "sourceType": "managerRun",
            "sourceThreadId": "office-thread-123456789",
            "sourceTurnId": "turn-1",
            "observedAt": sync_response.config["workspace"]["activity"]["runs"][0]["verificationChecks"][0]["observedAt"]
        })
    );
}

#[tokio::test]
async fn office_run_loop_review_waits_for_pending_verification_checks() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let prepared = processor
        .office_run_prepare(OfficeRunParams {
            cwd: cwd.clone(),
            config: json!({
                "title": "Platform Office",
                "workspace": {
                    "goal": "Ship the backend office",
                    "threadId": "office-thread-123456789",
                    "messages": [],
                    "tasks": [],
                    "activity": {
                        "approvals": [],
                        "artifacts": []
                    }
                }
            }),
            message: json!({
                "author": "User",
                "text": "Verify release readiness"
            }),
            text: "Verify release readiness".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare office run");
    let (_, started_config) = processor
        .office_run_mark_started(&cwd, prepared.config, &prepared.run_id, "turn-1")
        .await
        .expect("mark office run started");

    let sync_response = processor
        .office_run_sync(OfficeRunSyncParams {
            cwd: cwd.clone(),
            config: started_config,
            run_id: Some(prepared.run_id.clone()),
            turn: Turn {
                id: "turn-1".to_string(),
                items: vec![ThreadItem::AgentMessage {
                    id: "agent-message-1".to_string(),
                    text: r#"Needs verification.
```json
{
  "officeUpdate": {
    "summary": "Release readiness needs one more check.",
    "acceptanceCriteria": [
      { "criterion": "All checks pass", "status": "passed", "evidence": "Unit tests passed" }
    ],
    "verificationChecks": [
      { "check": "Run smoke automation", "status": "pending", "automationId": "nightly-smoke" }
    ],
    "evidence": [
      { "summary": "Unit tests passed", "status": "verified", "source": "just test" }
    ]
  }
}
```"#
                        .to_string(),
                    phase: None,
                    memory_citation: None,
                }],
                items_view: TurnItemsView::Full,
                status: TurnStatus::Completed,
                error: None,
                started_at: Some(1),
                completed_at: Some(2),
                duration_ms: Some(1_000),
            },
            locale: Some("en".to_string()),
        })
        .await
        .expect("sync office run with pending verification");

    let review = &sync_response.config["workspace"]["activity"]["runs"][0]["loop"]["review"];
    assert_eq!(
        review,
        &json!({
            "status": "needsReview",
            "nextAction": "runVerificationChecks",
            "acceptance": {
                "total": 1,
                "passed": 1,
                "failed": 0,
                "pending": 0
            },
            "verification": {
                "total": 1,
                "passed": 0,
                "failed": 0,
                "pending": 1,
                "runnablePending": 1,
                "missingRunnablePending": 0
            },
            "evidence": {
                "total": 1,
                "verified": 0,
                "blocked": 0
            },
            "risks": {
                "total": 0,
                "high": 0,
                "openHigh": 0
            },
            "updatedAt": review["updatedAt"]
        })
    );

    let retried = processor
        .office_run_retry_prepare(OfficeRunRetryParams {
            cwd,
            config: sync_response.config,
            run_id: prepared.run_id.clone(),
            message: None,
            text: None,
            locale: Some("en".to_string()),
            client_user_message_id: None,
        })
        .await
        .expect("prepare verification check retry");

    assert!(
        retried.prompt.contains(
            "Continue the previous Office Loop by running the pending verification checks"
        )
    );
    assert!(
        retried
            .prompt
            .contains("Next action: runVerificationChecks")
    );
    assert!(retried.prompt.contains("Run smoke automation"));
    assert!(retried.prompt.contains("nightly-smoke"));
    assert!(
        retried
            .prompt
            .contains("do not mark checks passed without real tool evidence")
    );
}

#[tokio::test]
async fn office_run_loop_review_does_not_run_text_only_or_canceling_verification_checks() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let prepared = processor
        .office_run_prepare(OfficeRunParams {
            cwd: cwd.clone(),
            config: json!({
                "title": "Platform Office",
                "workspace": {
                    "goal": "Ship the backend office",
                    "threadId": "office-thread-123456789",
                    "messages": [],
                    "tasks": [],
                    "activity": {
                        "approvals": [],
                        "artifacts": []
                    }
                }
            }),
            message: json!({
                "author": "User",
                "text": "Verify release readiness"
            }),
            text: "Verify release readiness".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare office run");
    let (_, mut started_config) = processor
        .office_run_mark_started(&cwd, prepared.config, &prepared.run_id, "turn-1")
        .await
        .expect("mark office run started");
    started_config["workspace"]["activity"]["runs"][0]["verificationChecks"] = json!([
        {
            "check": "Confirm release notes cover rollback behavior",
            "status": "pending"
        },
        {
            "check": "Run canceling smoke automation",
            "status": "pending",
            "dispatchStatus": "canceling",
            "automationId": "nightly-smoke"
        }
    ]);
    processor
        .office_save(OfficeSaveParams {
            cwd: cwd.clone(),
            config: started_config.clone(),
        })
        .await
        .expect("persist non-runnable verification checks");

    let sync_response = processor
        .office_run_sync(OfficeRunSyncParams {
            cwd,
            config: started_config,
            run_id: Some(prepared.run_id),
            turn: Turn {
                id: "turn-1".to_string(),
                items: vec![ThreadItem::AgentMessage {
                    id: "agent-message-1".to_string(),
                    text: r#"Needs a manual proof path.
```json
{
  "officeUpdate": {
    "summary": "Release readiness needs a defined verification path.",
    "acceptanceCriteria": [
      { "criterion": "All checks pass", "status": "passed", "evidence": "Unit tests passed" }
    ],
    "evidence": [
      { "summary": "Unit tests passed", "status": "verified", "source": "just test" }
    ]
  }
}
```"#
                        .to_string(),
                    phase: None,
                    memory_citation: None,
                }],
                items_view: TurnItemsView::Full,
                status: TurnStatus::Completed,
                error: None,
                started_at: Some(1),
                completed_at: Some(2),
                duration_ms: Some(1_000),
            },
            locale: Some("en".to_string()),
        })
        .await
        .expect("sync office run with non-runnable verification");

    let review = &sync_response.config["workspace"]["activity"]["runs"][0]["loop"]["review"];
    assert_eq!(
        review,
        &json!({
            "status": "needsReview",
            "nextAction": "collectVerificationEvidence",
            "acceptance": {
                "total": 1,
                "passed": 1,
                "failed": 0,
                "pending": 0
            },
            "verification": {
                "total": 2,
                "passed": 0,
                "failed": 0,
                "pending": 2,
                "runnablePending": 0,
                "missingRunnablePending": 2
            },
            "evidence": {
                "total": 1,
                "verified": 0,
                "blocked": 0
            },
            "risks": {
                "total": 0,
                "high": 0,
                "openHigh": 0
            },
            "updatedAt": review["updatedAt"]
        })
    );
}

#[tokio::test]
async fn office_run_evidence_gate_downgrades_model_reported_verification() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let prepared = processor
        .office_run_prepare(OfficeRunParams {
            cwd: cwd.clone(),
            config: json!({
                "title": "Platform Office",
                "workspace": {
                    "goal": "Ship the backend office",
                    "threadId": "office-thread-123456789",
                    "messages": [],
                    "tasks": [],
                    "activity": {
                        "approvals": [],
                        "artifacts": []
                    }
                }
            }),
            message: json!({
                "author": "User",
                "text": "Verify release readiness"
            }),
            text: "Verify release readiness".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare office run");
    let (_, started_config) = processor
        .office_run_mark_started(&cwd, prepared.config, &prepared.run_id, "turn-1")
        .await
        .expect("mark office run started");

    let sync_response = processor
        .office_run_sync(OfficeRunSyncParams {
            cwd,
            config: started_config,
            run_id: Some(prepared.run_id),
            turn: Turn {
                id: "turn-1".to_string(),
                items: vec![ThreadItem::AgentMessage {
                    id: "agent-message-1".to_string(),
                    text: r#"Verified from summary only.
```json
{
  "officeUpdate": {
    "summary": "Release readiness is verified.",
    "acceptanceCriteria": [
      { "criterion": "App-server tests pass", "criterionId": "criteria-tests", "status": "pending" }
    ],
    "verificationChecks": [
      { "check": "Run app-server tests", "criterionId": "criteria-tests", "status": "passed", "command": "just test -p crewon-app-server", "evidence": "I ran the tests." }
    ],
    "evidence": [
      { "summary": "I ran the tests.", "status": "verified", "source": "just test" }
    ]
  }
}
```"#
                    .to_string(),
                    phase: None,
                    memory_citation: None,
                }],
                items_view: TurnItemsView::Full,
                status: TurnStatus::Completed,
                error: None,
                started_at: Some(1),
                completed_at: Some(2),
                duration_ms: Some(1_000),
            },
            locale: Some("en".to_string()),
        })
        .await
        .expect("sync office run with model-reported verification");

    let run = &sync_response.config["workspace"]["activity"]["runs"][0];
    let verification_check = &run["verificationChecks"][0];
    assert_eq!(
        verification_check,
        &json!({
            "check": "Run app-server tests",
            "status": "pending",
            "criterionId": "criteria-tests",
            "command": "just test -p crewon-app-server",
            "evidence": "I ran the tests.",
            "sourceType": "managerRun",
            "sourceThreadId": "office-thread-123456789",
            "sourceTurnId": "turn-1",
            "observedAt": verification_check["observedAt"]
        })
    );
    assert_eq!(
        run["evidence"][0],
        json!({
            "summary": "I ran the tests.",
            "status": "observed",
            "source": "just test",
            "sourceType": "managerRun",
            "sourceThreadId": "office-thread-123456789",
            "sourceTurnId": "turn-1",
            "observedAt": run["evidence"][0]["observedAt"]
        })
    );
    assert_eq!(run["loop"]["review"]["status"], "needsReview");
    assert_eq!(run["loop"]["review"]["nextAction"], "runVerificationChecks");
    assert_eq!(run["loop"]["review"]["verification"]["passed"], 0);
    assert_eq!(run["loop"]["review"]["verification"]["pending"], 1);
    assert_eq!(run["loop"]["review"]["evidence"]["verified"], 0);
}

#[tokio::test]
async fn office_run_tool_evidence_marks_matching_verification_check() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let prepared = processor
        .office_run_prepare(OfficeRunParams {
            cwd: cwd.clone(),
            config: json!({
                "title": "Platform Office",
                "workspace": {
                    "goal": "Ship the backend office",
                    "threadId": "office-thread-123456789",
                    "messages": [],
                    "tasks": [],
                    "activity": {
                        "approvals": [],
                        "artifacts": []
                    }
                }
            }),
            message: json!({
                "author": "User",
                "text": "Verify release readiness"
            }),
            text: "Verify release readiness".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare office run");
    let (_, started_config) = processor
        .office_run_mark_started(&cwd, prepared.config, &prepared.run_id, "turn-1")
        .await
        .expect("mark office run started");

    let sync_response = processor
        .office_run_sync(OfficeRunSyncParams {
            cwd,
            config: started_config,
            run_id: Some(prepared.run_id),
            turn: Turn {
                id: "turn-1".to_string(),
                items: vec![
                    ThreadItem::CommandExecution {
                        id: "cmd-verification-1".to_string(),
                        command: "just test -p crewon-app-server".to_string(),
                        cwd: AbsolutePathBuf::from_absolute_path(temp_dir.path())
                            .expect("absolute cwd"),
                        process_id: None,
                        source: CommandExecutionSource::Agent,
                        status: CommandExecutionStatus::Completed,
                        command_actions: Vec::new(),
                        aggregated_output: Some("test result: ok".to_string()),
                        exit_code: Some(0),
                        duration_ms: Some(1_234),
                    },
                    ThreadItem::AgentMessage {
                        id: "agent-message-1".to_string(),
                        text: r#"Verified.
```json
{
  "officeUpdate": {
    "summary": "Release readiness is verified.",
    "acceptanceCriteria": [
      { "criterion": "All checks pass", "status": "passed", "evidence": "Verification command completed" }
    ],
    "verificationChecks": [
      { "check": "Run app-server tests", "status": "pending", "command": "just test -p crewon-app-server" }
    ]
  }
}
```"#
                            .to_string(),
                        phase: None,
                        memory_citation: None,
                    },
                ],
                items_view: TurnItemsView::Full,
                status: TurnStatus::Completed,
                error: None,
                started_at: Some(1),
                completed_at: Some(2),
                duration_ms: Some(1_000),
            },
            locale: Some("en".to_string()),
        })
        .await
        .expect("sync office run with matching verification command");

    let run = &sync_response.config["workspace"]["activity"]["runs"][0];
    let verification_check = &run["verificationChecks"][0];
    assert_eq!(
        verification_check,
        &json!({
            "check": "Run app-server tests",
            "status": "passed",
            "command": "just test -p crewon-app-server",
            "evidence": "Command completed: just test -p crewon-app-server",
            "sourceType": "managerRun",
            "sourceThreadId": "office-thread-123456789",
            "sourceTurnId": "turn-1",
            "observedAt": verification_check["observedAt"],
            "itemId": "cmd-verification-1",
            "evidenceKind": "commandExecution",
            "source": "commandExecution",
            "exitCode": 0,
            "durationMs": 1234,
            "outputPreview": "test result: ok",
            "outputSha256": sha256_hex(b"test result: ok")
        })
    );
    assert_eq!(run["loop"]["review"]["status"], "passed");
    assert_eq!(run["loop"]["review"]["verification"]["passed"], 1);
    assert_eq!(run["loop"]["review"]["evidence"]["verified"], 1);
}

#[tokio::test]
async fn office_run_tool_evidence_passes_referenced_acceptance_criterion() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let prepared = processor
        .office_run_prepare(OfficeRunParams {
            cwd: cwd.clone(),
            config: json!({
                "title": "Platform Office",
                "workspace": {
                    "goal": "Ship the backend office",
                    "threadId": "office-thread-123456789",
                    "messages": [],
                    "tasks": [],
                    "activity": {
                        "approvals": [],
                        "artifacts": []
                    }
                }
            }),
            message: json!({
                "author": "User",
                "text": "Verify release readiness"
            }),
            text: "Verify release readiness".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare office run");
    let (_, started_config) = processor
        .office_run_mark_started(&cwd, prepared.config, &prepared.run_id, "turn-1")
        .await
        .expect("mark office run started");

    let sync_response = processor
        .office_run_sync(OfficeRunSyncParams {
            cwd,
            config: started_config,
            run_id: Some(prepared.run_id),
            turn: Turn {
                id: "turn-1".to_string(),
                items: vec![
                    ThreadItem::CommandExecution {
                        id: "cmd-verification-1".to_string(),
                        command: "just test -p crewon-app-server".to_string(),
                        cwd: AbsolutePathBuf::from_absolute_path(temp_dir.path())
                            .expect("absolute cwd"),
                        process_id: None,
                        source: CommandExecutionSource::Agent,
                        status: CommandExecutionStatus::Completed,
                        command_actions: Vec::new(),
                        aggregated_output: Some("test result: ok".to_string()),
                        exit_code: Some(0),
                        duration_ms: Some(1_234),
                    },
                    ThreadItem::AgentMessage {
                        id: "agent-message-1".to_string(),
                        text: r#"Verified.
```json
{
  "officeUpdate": {
    "summary": "Release readiness has command evidence.",
    "acceptanceCriteria": [
      { "criterion": "App-server tests pass", "criterionId": "criteria-tests", "status": "pending" }
    ],
    "verificationChecks": [
      { "check": "Run app-server tests", "criterionId": "criteria-tests", "status": "pending", "command": "just test -p crewon-app-server" }
    ]
  }
}
```"#
                            .to_string(),
                        phase: None,
                        memory_citation: None,
                    },
                ],
                items_view: TurnItemsView::Full,
                status: TurnStatus::Completed,
                error: None,
                started_at: Some(1),
                completed_at: Some(2),
                duration_ms: Some(1_000),
            },
            locale: Some("en".to_string()),
        })
        .await
        .expect("sync office run with criterion-linked verification command");

    let run = &sync_response.config["workspace"]["activity"]["runs"][0];
    let acceptance = &run["acceptanceCriteria"][0];
    assert_eq!(
        acceptance,
        &json!({
            "criterion": "App-server tests pass",
            "criterionId": "criteria-tests",
            "status": "passed",
            "evidence": "Command completed: just test -p crewon-app-server",
            "source": "commandExecution",
            "sourceType": "managerRun",
            "sourceThreadId": "office-thread-123456789",
            "sourceTurnId": "turn-1",
            "observedAt": acceptance["observedAt"],
            "verifiedByCheck": "Run app-server tests",
            "verifiedByCheckItemId": "cmd-verification-1"
        })
    );
    assert_eq!(run["loop"]["review"]["status"], "passed");
    assert_eq!(run["loop"]["review"]["acceptance"]["passed"], 1);
    assert_eq!(run["loop"]["review"]["verification"]["passed"], 1);
}

#[tokio::test]
async fn office_run_retry_uses_loop_review_repair_prompt() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let prepared = processor
        .office_run_prepare(OfficeRunParams {
            cwd: cwd.clone(),
            config: json!({
                "title": "Platform Office",
                "workspace": {
                    "goal": "Ship the backend office",
                    "threadId": "office-thread-123456789",
                    "messages": [],
                    "tasks": [],
                    "activity": {
                        "approvals": [],
                        "artifacts": []
                    }
                }
            }),
            message: json!({
                "author": "User",
                "text": "Check release readiness"
            }),
            text: "Check release readiness".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare office run");
    let (_, started_config) = processor
        .office_run_mark_started(&cwd, prepared.config, &prepared.run_id, "turn-1")
        .await
        .expect("mark office run started");
    let sync_response = processor
        .office_run_sync(OfficeRunSyncParams {
            cwd: cwd.clone(),
            config: started_config,
            run_id: Some(prepared.run_id.clone()),
            turn: Turn {
                id: "turn-1".to_string(),
                items: vec![ThreadItem::AgentMessage {
                    id: "agent-message-1".to_string(),
                    text: r#"Blocked.
```json
{
  "officeUpdate": {
    "summary": "Release readiness is blocked.",
    "acceptanceCriteria": [
      { "criterion": "All checks pass", "status": "failed", "evidence": "Integration test failed" }
    ],
    "verificationChecks": [
      { "check": "Run integration suite", "status": "failed", "command": "just test -p crewon-app-server", "evidence": "suite failed" }
    ],
    "evidence": [
      { "summary": "Integration test failed", "status": "blocked", "source": "just test" }
    ],
    "risks": [
      { "summary": "Release could regress users", "severity": "high" }
    ]
  }
}
```"#
                        .to_string(),
                    phase: None,
                    memory_citation: None,
                }],
                items_view: TurnItemsView::Full,
                status: TurnStatus::Completed,
                error: None,
                started_at: Some(1),
                completed_at: Some(2),
                duration_ms: Some(1_000),
            },
            locale: Some("en".to_string()),
        })
        .await
        .expect("sync blocked office run");

    let retried = processor
        .office_run_retry_prepare(OfficeRunRetryParams {
            cwd,
            config: sync_response.config,
            run_id: prepared.run_id.clone(),
            message: None,
            text: None,
            locale: Some("en".to_string()),
            client_user_message_id: None,
        })
        .await
        .expect("prepare loop repair retry");

    assert!(retried.prompt.contains("Continue the previous Office Loop"));
    assert!(retried.prompt.contains("Next action: repairFailedCriteria"));
    assert!(retried.prompt.contains("All checks pass"));
    assert!(
        retried
            .prompt
            .contains("Failed or pending verification checks")
    );
    assert!(retried.prompt.contains("Run integration suite"));
    assert!(retried.prompt.contains("just test -p crewon-app-server"));
    assert!(retried.prompt.contains("Integration test failed"));
    assert!(retried.prompt.contains("Release could regress users"));
    assert!(
        retried.config["workspace"]["activity"]["runs"][0]["requestText"]
            .as_str()
            .expect("retry request text")
            .contains("Continue the previous Office Loop")
    );
    assert_eq!(
        retried.config["workspace"]["activity"]["runs"][0]["loop"]["iteration"],
        2
    );
    assert_eq!(
        retried.config["workspace"]["activity"]["runs"][0]["loop"]["maxIterations"],
        4
    );
    assert_eq!(
        retried.config["workspace"]["activity"]["runs"][0]["loop"]["metrics"]["retryBudgetRemaining"],
        2
    );
    let stop_conditions =
        retried.config["workspace"]["activity"]["runs"][0]["loop"]["stopConditions"]
            .as_array()
            .expect("loop stop conditions");
    assert!(stop_conditions.iter().any(|condition| {
        condition["condition"] == "hasRetryBudget" && condition["met"] == true
    }));
    assert_eq!(
        retried.config["workspace"]["activity"]["runs"][0]["retryOf"],
        prepared.run_id
    );
}

fn completed_office_turn(id: &str) -> Turn {
    Turn {
        id: id.to_string(),
        items: Vec::new(),
        items_view: TurnItemsView::Full,
        status: TurnStatus::Completed,
        error: None,
        started_at: Some(1),
        completed_at: Some(2),
        duration_ms: Some(1_000),
    }
}

#[tokio::test]
async fn office_auto_retry_prepares_next_manager_iteration_from_review() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let config = json!({
        "title": "Platform Office",
        "workspace": {
            "goal": "Ship the backend office",
            "threadId": "office-thread-123456789",
            "messages": [],
            "tasks": [],
            "activity": {
                "approvals": [],
                "artifacts": [],
                "runs": [{
                    "id": "office-run-source",
                    "title": "Repair release",
                    "status": "completed",
                    "threadId": "office-thread-123456789",
                    "turnId": "turn-1",
                    "requestText": "Check release readiness",
                    "acceptanceCriteria": [{
                        "criterion": "All checks pass",
                        "status": "failed",
                        "evidence": "Integration test failed"
                    }],
                    "evidence": [{
                        "summary": "Integration test failed",
                        "status": "blocked",
                        "source": "just test"
                    }],
                    "verificationChecks": [{
                        "check": "Run integration suite",
                        "status": "failed",
                        "command": "just test -p crewon-app-server",
                        "evidence": "suite failed"
                    }],
                    "loop": {
                        "mode": "officeLoopEngineering",
                        "iteration": 1,
                        "maxIterations": 4,
                        "review": {
                            "status": "blocked",
                            "nextAction": "repairFailedCriteria"
                        }
                    }
                }]
            }
        }
    });
    processor
        .office_save(OfficeSaveParams {
            cwd: cwd.clone(),
            config: config.clone(),
        })
        .await
        .expect("save office run");

    let prepared = processor
        .office_auto_retry_prepare_after_thread_turn(
            &cwd,
            "office-thread-123456789",
            &completed_office_turn("turn-1"),
        )
        .await
        .expect("prepare auto retry")
        .expect("eligible auto retry");

    assert_eq!(prepared.thread_id, "office-thread-123456789");
    assert!(prepared.prompt.contains("repairFailedCriteria"));
    let retry_run = &prepared.config["workspace"]["activity"]["runs"][0];
    assert_eq!(retry_run["status"], "queued");
    assert_eq!(retry_run["retryOf"], "office-run-source");
    assert_eq!(retry_run["loop"]["iteration"], 2);
    assert_eq!(retry_run["loop"]["maxIterations"], 4);
    assert_eq!(retry_run["loop"]["metrics"]["retryBudgetRemaining"], 2);
}

#[tokio::test]
async fn office_auto_retry_is_idempotent_for_source_run() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let config = json!({
        "title": "Platform Office",
        "workspace": {
            "goal": "Ship the backend office",
            "threadId": "office-thread-123456789",
            "messages": [],
            "tasks": [],
            "activity": {
                "approvals": [],
                "artifacts": [],
                "runs": [
                    {
                        "id": "office-run-source",
                        "title": "Repair release",
                        "status": "completed",
                        "threadId": "office-thread-123456789",
                        "turnId": "turn-1",
                        "requestText": "Check release readiness",
                        "loop": {
                            "mode": "officeLoopEngineering",
                            "iteration": 1,
                            "maxIterations": 4,
                            "review": {
                                "status": "blocked",
                                "nextAction": "repairFailedCriteria"
                            }
                        }
                    },
                    {
                        "id": "office-run-retry",
                        "title": "Repair release retry",
                        "status": "completed",
                        "threadId": "office-thread-123456789",
                        "turnId": "turn-2",
                        "requestText": "Continue release repair",
                        "retryOf": "office-run-source",
                        "loop": {
                            "mode": "officeLoopEngineering",
                            "iteration": 2,
                            "maxIterations": 4,
                            "review": {
                                "status": "passed",
                                "nextAction": "readyToSummarize"
                            }
                        }
                    }
                ]
            }
        }
    });
    processor
        .office_save(OfficeSaveParams {
            cwd: cwd.clone(),
            config: config.clone(),
        })
        .await
        .expect("save office run");

    let prepared = processor
        .office_auto_retry_prepare_after_thread_turn(
            &cwd,
            "office-thread-123456789",
            &completed_office_turn("turn-1"),
        )
        .await
        .expect("check auto retry eligibility");

    assert!(prepared.is_none());
}

#[tokio::test]
async fn office_auto_retry_waits_for_acceptance_frame() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let config = json!({
        "title": "Platform Office",
        "workspace": {
            "goal": "Ship the backend office",
            "threadId": "office-thread-123456789",
            "messages": [],
            "tasks": [],
            "activity": {
                "approvals": [],
                "artifacts": [],
                "runs": [{
                    "id": "office-run-source",
                    "title": "Frame release",
                    "status": "completed",
                    "threadId": "office-thread-123456789",
                    "turnId": "turn-1",
                    "requestText": "Check release readiness",
                    "loop": {
                        "mode": "officeLoopEngineering",
                        "iteration": 1,
                        "maxIterations": 4,
                        "review": {
                            "status": "incomplete",
                            "nextAction": "frameAcceptanceCriteria"
                        }
                    }
                }]
            }
        }
    });
    processor
        .office_save(OfficeSaveParams {
            cwd: cwd.clone(),
            config: config.clone(),
        })
        .await
        .expect("save office run");

    let prepared = processor
        .office_auto_retry_prepare_after_thread_turn(
            &cwd,
            "office-thread-123456789",
            &completed_office_turn("turn-1"),
        )
        .await
        .expect("check auto retry eligibility");

    assert!(prepared.is_none());
}

#[tokio::test]
async fn office_auto_retry_waits_for_runnable_verification_dispatch() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let config = json!({
        "title": "Platform Office",
        "workspace": {
            "goal": "Ship the backend office",
            "threadId": "office-thread-123456789",
            "messages": [],
            "tasks": [],
            "activity": {
                "approvals": [],
                "artifacts": [],
                "runs": [{
                    "id": "office-run-source",
                    "title": "Verify release",
                    "status": "completed",
                    "threadId": "office-thread-123456789",
                    "turnId": "turn-1",
                    "requestText": "Verify release readiness",
                    "verificationChecks": [{
                        "check": "Run smoke automation",
                        "status": "pending",
                        "automationId": "nightly-smoke"
                    }],
                    "loop": {
                        "mode": "officeLoopEngineering",
                        "iteration": 1,
                        "maxIterations": 4,
                        "review": {
                            "status": "needsReview",
                            "nextAction": "runVerificationChecks"
                        }
                    }
                }]
            }
        }
    });
    processor
        .office_save(OfficeSaveParams {
            cwd: cwd.clone(),
            config: config.clone(),
        })
        .await
        .expect("save office run");

    let prepared = processor
        .office_auto_retry_prepare_after_thread_turn(
            &cwd,
            "office-thread-123456789",
            &completed_office_turn("turn-1"),
        )
        .await
        .expect("check auto retry eligibility");

    assert!(prepared.is_none());
}

#[tokio::test]
async fn office_auto_retry_waits_for_active_automation_child() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let config = json!({
        "title": "Platform Office",
        "workspace": {
            "goal": "Ship the backend office",
            "threadId": "office-thread-123456789",
            "messages": [],
            "tasks": [],
            "activity": {
                "approvals": [],
                "artifacts": [],
                "runs": [{
                    "id": "office-run-source",
                    "title": "Repair release",
                    "status": "completed",
                    "threadId": "office-thread-123456789",
                    "turnId": "turn-1",
                    "requestText": "Check release readiness",
                    "verificationChecks": [{
                        "check": "Run smoke automation",
                        "status": "pending",
                        "automationId": "nightly-smoke",
                        "automationStatus": "running"
                    }],
                    "loop": {
                        "mode": "officeLoopEngineering",
                        "iteration": 1,
                        "maxIterations": 4,
                        "review": {
                            "status": "needsReview",
                            "nextAction": "collectVerificationEvidence"
                        }
                    }
                }]
            }
        }
    });
    processor
        .office_save(OfficeSaveParams {
            cwd: cwd.clone(),
            config: config.clone(),
        })
        .await
        .expect("save office run");

    let prepared = processor
        .office_auto_retry_prepare_after_thread_turn(
            &cwd,
            "office-thread-123456789",
            &completed_office_turn("turn-1"),
        )
        .await
        .expect("check auto retry eligibility");

    assert!(prepared.is_none());
}

#[tokio::test]
async fn office_run_retry_preserves_source_loop_max_iterations() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let config = json!({
        "title": "Platform Office",
        "workspace": {
            "goal": "Ship the backend office",
            "threadId": "office-thread-123456789",
            "messages": [],
            "tasks": [],
            "activity": {
                "approvals": [],
                "artifacts": [],
                "runs": [{
                    "id": "office-run-source",
                    "title": "Repair release",
                    "status": "completed",
                    "threadId": "office-thread-123456789",
                    "requestText": "Repair release",
                    "loop": {
                        "mode": "officeLoopEngineering",
                        "iteration": 1,
                        "maxIterations": 6
                    }
                }]
            }
        }
    });

    let retried = processor
        .office_run_retry_prepare(OfficeRunRetryParams {
            cwd,
            config,
            run_id: "office-run-source".to_string(),
            message: None,
            text: Some("Continue release repair".to_string()),
            locale: Some("en".to_string()),
            client_user_message_id: None,
        })
        .await
        .expect("prepare retry with custom loop budget");

    assert_eq!(
        retried.config["workspace"]["activity"]["runs"][0]["loop"]["iteration"],
        2
    );
    assert_eq!(
        retried.config["workspace"]["activity"]["runs"][0]["loop"]["maxIterations"],
        6
    );
    assert_eq!(
        retried.config["workspace"]["activity"]["runs"][0]["loop"]["metrics"]["retryBudgetRemaining"],
        4
    );
}

#[tokio::test]
async fn office_run_retry_rejects_when_loop_iteration_limit_reached() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let config = json!({
        "title": "Platform Office",
        "workspace": {
            "goal": "Ship the backend office",
            "threadId": "office-thread-123456789",
            "messages": [],
            "tasks": [],
            "activity": {
                "approvals": [],
                "artifacts": [],
                "runs": [{
                    "id": "office-run-limited",
                    "title": "Repair release",
                    "status": "completed",
                    "threadId": "office-thread-123456789",
                    "requestText": "Repair release",
                    "loop": {
                        "mode": "officeLoopEngineering",
                        "iteration": 4,
                        "maxIterations": 4,
                        "status": "iterationLimit",
                        "review": {
                            "status": "needsReview",
                            "nextAction": "repairFailedCriteria"
                        }
                    }
                }]
            }
        }
    });
    processor
        .office_save(OfficeSaveParams {
            cwd: cwd.clone(),
            config: config.clone(),
        })
        .await
        .expect("save limited office run");

    let err = processor
        .office_run_retry_prepare(OfficeRunRetryParams {
            cwd,
            config,
            run_id: "office-run-limited".to_string(),
            message: None,
            text: Some("Try one more time".to_string()),
            locale: Some("en".to_string()),
            client_user_message_id: None,
        })
        .await
        .expect_err("reject retry after loop iteration limit");

    assert_eq!(err.message, "office loop iteration limit reached");
}

#[tokio::test]
async fn office_run_sync_persists_and_retrieves_long_term_memory() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let prepared = processor
        .office_run_prepare(OfficeRunParams {
            cwd: cwd.clone(),
            config: json!({
                "title": "Platform Office",
                "workspace": {
                    "goal": "Ship the backend office",
                    "threadId": "office-thread-123456789",
                    "members": [{
                        "name": "Reviewer",
                        "role": "Review final changes",
                        "status": "online",
                        "agentId": "agent-reviewer",
                        "runtime": {
                            "threadId": "reviewer-thread-1",
                            "contextPolicy": "sharedDigest",
                            "memoryScope": "privateAndShared"
                        }
                    }],
                    "messages": [],
                    "tasks": [],
                    "activity": {
                        "approvals": [],
                        "artifacts": []
                    }
                }
            }),
            message: json!({
                "author": "User",
                "text": "Record the reducer decision"
            }),
            text: "Record the reducer decision".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare office run");
    assert!(
        prepared
            .prompt
            .contains("runtimeThreadId=reviewer-thread-1")
    );
    assert!(prepared.prompt.contains("Loop Engineering"));
    let (_, started_config) = processor
        .office_run_mark_started(&cwd, prepared.config, &prepared.run_id, "turn-1")
        .await
        .expect("mark office run started");

    let run_id = prepared.run_id.clone();
    let sync_response = processor
        .office_run_sync(OfficeRunSyncParams {
            cwd: cwd.clone(),
            config: started_config,
            run_id: Some(run_id.clone()),
            turn: Turn {
                id: "turn-1".to_string(),
                items: vec![ThreadItem::AgentMessage {
                    id: "agent-message-1".to_string(),
                    text: r#"Done.
```json
{
  "officeUpdate": {
    "summary": "Reducer decision recorded.",
    "memories": [
      {
        "scope": "office",
        "kind": "decision",
        "content": "Reducer state for Office runs stays in app-server and must not move into crewon-core.",
        "confidence": "high",
        "importance": "high",
        "status": "accepted"
      }
    ]
  }
}
```"#
                    .to_string(),
                    phase: None,
                    memory_citation: None,
                }],
                items_view: TurnItemsView::Full,
                status: TurnStatus::Completed,
                error: None,
                started_at: Some(1),
                completed_at: Some(2),
                duration_ms: Some(1_000),
            },
            locale: Some("en".to_string()),
        })
        .await
        .expect("sync memory update");
    let config = sync_response.config;
    let memory_refs = config["workspace"]["activity"]["runs"][0]["memoryRefs"]
        .as_array()
        .expect("run memory refs");
    assert_eq!(memory_refs.len(), 1);
    assert_eq!(memory_refs[0]["kind"], "decision");
    assert_eq!(memory_refs[0]["confidence"], "high");
    assert_eq!(memory_refs[0]["importance"], "high");
    assert_eq!(memory_refs[0]["status"], "pending");
    assert_eq!(memory_refs[0]["evidenceRefs"][0]["runId"], run_id);
    assert_eq!(
        memory_refs[0]["evidenceRefs"][0]["threadId"],
        "office-thread-123456789"
    );
    assert_eq!(memory_refs[0]["evidenceRefs"][0]["turnId"], "turn-1");
    let memory_id = memory_refs[0]["id"]
        .as_str()
        .expect("memory id")
        .to_string();

    let memory_index_path = temp_dir
        .path()
        .join(".crewon")
        .join("office-memory")
        .join("index.json");
    let memory_index = std::fs::read_to_string(memory_index_path).expect("read memory index");
    let memory_index: serde_json::Value =
        serde_json::from_str(&memory_index).expect("parse memory index");
    assert_eq!(memory_index["memories"][0]["scope"], "office");
    assert_eq!(memory_index["memories"][0]["confidence"], "high");
    assert_eq!(memory_index["memories"][0]["importance"], "high");
    assert_eq!(memory_index["memories"][0]["status"], "pending");
    assert_eq!(
        memory_index["memories"][0]["evidenceRefs"][0]["turnId"],
        "turn-1"
    );
    let decision_response = processor
        .office_memory_decide(OfficeMemoryDecideParams {
            cwd: cwd.clone(),
            config: config.clone(),
            memory_id,
            status: "accepted".to_string(),
        })
        .await
        .expect("accept office memory");
    assert_eq!(decision_response.memory.status, "accepted");
    assert_eq!(decision_response.memory.importance, "high");
    let read_response = processor
        .office_read(OfficeReadParams {
            cwd: cwd.clone(),
            thread_id: Some("office-thread-123456789".to_string()),
            title: None,
        })
        .await
        .expect("read office after memory decision");
    assert_eq!(
        read_response.record.expect("office record").config["workspace"]["activity"]["runs"][0]["memoryRefs"]
            [0]["status"],
        "accepted"
    );

    let next_prepared = processor
        .office_run_prepare(OfficeRunParams {
            cwd,
            config,
            message: json!({
                "author": "User",
                "text": "Use the reducer decision"
            }),
            text: "Use the reducer decision".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare office run with memory retrieval");
    assert!(
        next_prepared
            .prompt
            .contains("Reducer state for Office runs stays in app-server")
    );
    assert_eq!(
        next_prepared.config["workspace"]["activity"]["runs"][0]["memoryRefs"][0]["kind"],
        "decision"
    );
    assert_eq!(
        next_prepared.config["workspace"]["activity"]["runs"][0]["memoryRefs"][0]["status"],
        "accepted"
    );
    assert_eq!(
        next_prepared.config["workspace"]["activity"]["runs"][0]["memoryRefs"][0]["confidence"],
        "high"
    );
    assert_eq!(
        next_prepared.config["workspace"]["activity"]["runs"][0]["memoryRefs"][0]["importance"],
        "high"
    );
    assert_eq!(
        next_prepared.config["workspace"]["activity"]["runs"][0]["memoryRefs"][0]["evidenceRefs"]
            [0]["turnId"],
        "turn-1"
    );
}

#[tokio::test]
async fn office_run_memory_retrieval_scores_chinese_text() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let base_config = json!({
        "title": "Platform Office",
        "workspace": {
            "goal": "Ship the backend office",
            "threadId": "office-thread-123456789",
            "messages": [],
            "tasks": [],
            "activity": {
                "approvals": [],
                "artifacts": []
            }
        }
    });
    let prepared_relevant = processor
        .office_run_prepare(OfficeRunParams {
            cwd: cwd.clone(),
            config: base_config,
            message: json!({
                "author": "User",
                "text": "记录中文验收策略"
            }),
            text: "记录中文验收策略".to_string(),
            locale: Some("zh".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare relevant memory run");
    let (_, started_relevant) = processor
        .office_run_mark_started(
            &cwd,
            prepared_relevant.config,
            &prepared_relevant.run_id,
            "turn-relevant",
        )
        .await
        .expect("mark relevant run started");
    let relevant_sync = processor
        .office_run_sync(OfficeRunSyncParams {
            cwd: cwd.clone(),
            config: started_relevant,
            run_id: Some(prepared_relevant.run_id),
            turn: Turn {
                id: "turn-relevant".to_string(),
                items: vec![ThreadItem::AgentMessage {
                    id: "agent-message-1".to_string(),
                    text: r#"完成。
```json
{
  "officeUpdate": {
    "summary": "中文记忆已记录。",
    "memories": [
      {
        "scope": "office",
        "kind": "decision",
        "content": "中文验收策略必须保留证据链和风险说明。",
        "confidence": "high",
        "status": "accepted"
      }
    ]
  }
}
```"#
                        .to_string(),
                    phase: None,
                    memory_citation: None,
                }],
                items_view: TurnItemsView::Full,
                status: TurnStatus::Completed,
                error: None,
                started_at: Some(1),
                completed_at: Some(2),
                duration_ms: Some(1_000),
            },
            locale: Some("zh".to_string()),
        })
        .await
        .expect("sync relevant memory");
    let relevant_config = relevant_sync.config;
    let relevant_memory_id =
        relevant_config["workspace"]["activity"]["runs"][0]["memoryRefs"][0]["id"]
            .as_str()
            .expect("relevant memory id")
            .to_string();
    processor
        .office_memory_decide(OfficeMemoryDecideParams {
            cwd: cwd.clone(),
            config: relevant_config.clone(),
            memory_id: relevant_memory_id,
            status: "accepted".to_string(),
        })
        .await
        .expect("accept relevant memory");

    let prepared_irrelevant = processor
        .office_run_prepare(OfficeRunParams {
            cwd: cwd.clone(),
            config: relevant_config,
            message: json!({
                "author": "User",
                "text": "记录其他中文事实"
            }),
            text: "记录其他中文事实".to_string(),
            locale: Some("zh".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare irrelevant memory run");
    let (_, started_irrelevant) = processor
        .office_run_mark_started(
            &cwd,
            prepared_irrelevant.config,
            &prepared_irrelevant.run_id,
            "turn-irrelevant",
        )
        .await
        .expect("mark irrelevant run started");
    let irrelevant_sync = processor
        .office_run_sync(OfficeRunSyncParams {
            cwd: cwd.clone(),
            config: started_irrelevant,
            run_id: Some(prepared_irrelevant.run_id),
            turn: Turn {
                id: "turn-irrelevant".to_string(),
                items: vec![ThreadItem::AgentMessage {
                    id: "agent-message-2".to_string(),
                    text: r#"完成。
```json
{
  "officeUpdate": {
    "summary": "无关中文记忆已记录。",
    "memories": [
      { "scope": "office", "kind": "fact", "content": "预算记录甲需要每周复核。", "status": "accepted" },
      { "scope": "office", "kind": "fact", "content": "会议纪要乙保存在共享目录。", "status": "accepted" },
      { "scope": "office", "kind": "fact", "content": "发布窗口丙固定在周三。", "status": "accepted" },
      { "scope": "office", "kind": "fact", "content": "值班安排丁由平台组维护。", "status": "accepted" },
      { "scope": "office", "kind": "fact", "content": "演示材料戊需要产品确认。", "status": "accepted" },
      { "scope": "office", "kind": "fact", "content": "客户清单己暂存在归档区。", "status": "accepted" }
    ]
  }
}
```"#
                    .to_string(),
                    phase: None,
                    memory_citation: None,
                }],
                items_view: TurnItemsView::Full,
                status: TurnStatus::Completed,
                error: None,
                started_at: Some(3),
                completed_at: Some(4),
                duration_ms: Some(1_000),
            },
            locale: Some("zh".to_string()),
        })
        .await
        .expect("sync irrelevant memories");
    let pending_memories = processor
        .office_memory_list(OfficeMemoryListParams {
            cwd: cwd.clone(),
            config: irrelevant_sync.config.clone(),
            status: Some("pending".to_string()),
            cursor: None,
            limit: Some(12),
        })
        .await
        .expect("list pending Chinese memories");
    let pending_contents = pending_memories
        .data
        .iter()
        .map(|memory| memory.content.as_str())
        .collect::<Vec<_>>();
    assert_eq!(pending_contents.len(), 6);
    for expected in [
        "预算记录甲需要每周复核。",
        "会议纪要乙保存在共享目录。",
        "发布窗口丙固定在周三。",
        "值班安排丁由平台组维护。",
        "演示材料戊需要产品确认。",
        "客户清单己暂存在归档区。",
    ] {
        assert!(
            pending_contents.contains(&expected),
            "missing pending Chinese memory: {expected}"
        );
    }

    let next_prepared = processor
        .office_run_prepare(OfficeRunParams {
            cwd,
            config: irrelevant_sync.config,
            message: json!({
                "author": "User",
                "text": "复用验收策略"
            }),
            text: "复用验收策略".to_string(),
            locale: Some("zh".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare Chinese memory retrieval run");

    assert!(
        next_prepared
            .prompt
            .contains("中文验收策略必须保留证据链和风险说明")
    );
    let memory_refs = next_prepared.config["workspace"]["activity"]["runs"][0]["memoryRefs"]
        .as_array()
        .expect("retrieved memory refs");
    assert!(memory_refs.iter().any(|memory| {
        memory.get("content").and_then(|content| content.as_str())
            == Some("中文验收策略必须保留证据链和风险说明。")
    }));
}

#[tokio::test]
async fn office_run_memory_retrieval_prefers_relevance_before_recent_irrelevant_items() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let memory_dir = temp_dir.path().join(".crewon").join("office-memory");
    std::fs::create_dir_all(&memory_dir).expect("create memory directory");
    std::fs::write(
        memory_dir.join("index.json"),
        serde_json::to_string_pretty(&json!({
            "version": 1,
            "memories": [
                {
                    "id": "memory-relevant",
                    "officeKey": "office-thread-123456789",
                    "scope": "office",
                    "member": null,
                    "agentId": null,
                    "kind": "decision",
                    "content": "Launch acceptance smoke checks must run before shipping.",
                    "confidence": "high",
                    "importance": "high",
                    "status": "accepted",
                    "evidenceRefs": [],
                    "keywords": ["launch", "acceptance", "smoke", "checks"],
                    "createdAt": "2026-01-01T00:00:00Z",
                    "updatedAt": "2026-01-01T00:00:00Z",
                    "lastUsedAt": null,
                    "usageCount": 0
                },
                {
                    "id": "memory-ir-1",
                    "officeKey": "office-thread-123456789",
                    "scope": "office",
                    "member": null,
                    "agentId": null,
                    "kind": "fact",
                    "content": "Coffee rotation is reviewed on Monday.",
                    "confidence": "high",
                    "importance": "high",
                    "status": "accepted",
                    "evidenceRefs": [],
                    "keywords": ["coffee", "rotation"],
                    "createdAt": "2026-06-20T00:00:00Z",
                    "updatedAt": "2026-06-20T00:00:00Z",
                    "lastUsedAt": "2026-06-20T00:00:00Z",
                    "usageCount": 5
                },
                {
                    "id": "memory-ir-2",
                    "officeKey": "office-thread-123456789",
                    "scope": "office",
                    "member": null,
                    "agentId": null,
                    "kind": "fact",
                    "content": "Design review room changes every Friday.",
                    "confidence": "high",
                    "importance": "high",
                    "status": "accepted",
                    "evidenceRefs": [],
                    "keywords": ["design", "room"],
                    "createdAt": "2026-06-20T00:00:01Z",
                    "updatedAt": "2026-06-20T00:00:01Z",
                    "lastUsedAt": "2026-06-20T00:00:01Z",
                    "usageCount": 5
                },
                {
                    "id": "memory-ir-3",
                    "officeKey": "office-thread-123456789",
                    "scope": "office",
                    "member": null,
                    "agentId": null,
                    "kind": "fact",
                    "content": "Weekly notes are archived in the shared folder.",
                    "confidence": "high",
                    "importance": "high",
                    "status": "accepted",
                    "evidenceRefs": [],
                    "keywords": ["weekly", "notes"],
                    "createdAt": "2026-06-20T00:00:02Z",
                    "updatedAt": "2026-06-20T00:00:02Z",
                    "lastUsedAt": "2026-06-20T00:00:02Z",
                    "usageCount": 5
                },
                {
                    "id": "memory-ir-4",
                    "officeKey": "office-thread-123456789",
                    "scope": "office",
                    "member": null,
                    "agentId": null,
                    "kind": "fact",
                    "content": "Demo assets need product signoff.",
                    "confidence": "high",
                    "importance": "high",
                    "status": "accepted",
                    "evidenceRefs": [],
                    "keywords": ["demo", "assets"],
                    "createdAt": "2026-06-20T00:00:03Z",
                    "updatedAt": "2026-06-20T00:00:03Z",
                    "lastUsedAt": "2026-06-20T00:00:03Z",
                    "usageCount": 5
                },
                {
                    "id": "memory-ir-5",
                    "officeKey": "office-thread-123456789",
                    "scope": "office",
                    "member": null,
                    "agentId": null,
                    "kind": "fact",
                    "content": "Calendar cleanup is owned by operations.",
                    "confidence": "high",
                    "importance": "high",
                    "status": "accepted",
                    "evidenceRefs": [],
                    "keywords": ["calendar", "cleanup"],
                    "createdAt": "2026-06-20T00:00:04Z",
                    "updatedAt": "2026-06-20T00:00:04Z",
                    "lastUsedAt": "2026-06-20T00:00:04Z",
                    "usageCount": 5
                },
                {
                    "id": "memory-ir-6",
                    "officeKey": "office-thread-123456789",
                    "scope": "office",
                    "member": null,
                    "agentId": null,
                    "kind": "fact",
                    "content": "Library labels are maintained by support.",
                    "confidence": "high",
                    "importance": "high",
                    "status": "accepted",
                    "evidenceRefs": [],
                    "keywords": ["library", "labels"],
                    "createdAt": "2026-06-20T00:00:05Z",
                    "updatedAt": "2026-06-20T00:00:05Z",
                    "lastUsedAt": "2026-06-20T00:00:05Z",
                    "usageCount": 5
                }
            ]
        }))
        .expect("serialize memory index"),
    )
    .expect("write memory index");

    let prepared = processor
        .office_run_prepare(OfficeRunParams {
            cwd,
            config: json!({
                "title": "Platform Office",
                "workspace": {
                    "goal": "Ship launch checks",
                    "threadId": "office-thread-123456789",
                    "messages": [],
                    "tasks": [],
                    "activity": {
                        "approvals": [],
                        "artifacts": []
                    }
                }
            }),
            message: json!({
                "author": "User",
                "text": "Prepare launch acceptance checks"
            }),
            text: "Prepare launch acceptance checks".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare office run with scored memory retrieval");

    assert!(
        prepared
            .prompt
            .contains("Launch acceptance smoke checks must run before shipping.")
    );
    let memory_refs = prepared.config["workspace"]["activity"]["runs"][0]["memoryRefs"]
        .as_array()
        .expect("retrieved memory refs");
    assert_eq!(memory_refs.len(), 6);
    assert_eq!(memory_refs[0]["id"], "memory-relevant");
    assert_eq!(memory_refs[0]["importance"], "high");
}

#[tokio::test]
async fn office_run_retry_and_cancel_update_run_index_and_state() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let prepared = processor
        .office_run_prepare(OfficeRunParams {
            cwd: cwd.clone(),
            config: json!({
                "title": "Platform Office",
                "workspace": {
                    "goal": "Ship the backend office",
                    "threadId": "office-thread-123456789",
                    "messages": [],
                    "tasks": [],
                    "activity": {
                        "approvals": [],
                        "artifacts": []
                    }
                }
            }),
            message: json!({
                "author": "User",
                "text": "Run a retryable office task"
            }),
            text: "Run a retryable office task".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare office run");
    let (_, mut started_config) = processor
        .office_run_mark_started(&cwd, prepared.config, &prepared.run_id, "turn-1")
        .await
        .expect("mark office run started");
    started_config["workspace"]["activity"]["runs"][0]["delegations"] = json!([
        {
            "id": "delegation-running",
            "member": "Reviewer",
            "agentId": "agent-reviewer",
            "task": "Review active work",
            "status": "running",
            "threadId": "member-thread-123456789",
            "turnId": "member-turn-1"
        },
        {
            "id": "delegation-completed",
            "member": "Builder",
            "agentId": "agent-builder",
            "task": "Completed task",
            "status": "completed",
            "threadId": "builder-thread-123456789",
            "turnId": "builder-turn-1"
        }
    ]);
    started_config["workspace"]["activity"]["runs"][0]["verificationChecks"] = json!([
        {
            "itemId": "verification-running",
            "check": "Run active automation",
            "status": "pending",
            "dispatchStatus": "running",
            "automationId": "Nightly QA",
            "automationThreadId": "automation-thread-123456789",
            "automationTurnId": "automation-turn-1"
        },
        {
            "itemId": "verification-passed",
            "check": "Completed automation",
            "status": "passed",
            "dispatchStatus": "completed",
            "automationId": "Nightly QA",
            "automationThreadId": "automation-thread-123456789",
            "automationTurnId": "automation-turn-2"
        }
    ]);
    processor
        .office_save(OfficeSaveParams {
            cwd: cwd.clone(),
            config: started_config.clone(),
        })
        .await
        .expect("persist active child turns");

    let cancel = processor
        .office_run_cancel_prepare(OfficeRunCancelParams {
            cwd: cwd.clone(),
            config: started_config.clone(),
            run_id: prepared.run_id.clone(),
            thread_id: None,
            turn_id: None,
            locale: Some("en".to_string()),
        })
        .await
        .expect("prepare office run cancel");
    assert_eq!(cancel.thread_id, "office-thread-123456789");
    assert_eq!(cancel.turn_id, "turn-1");
    let cancel_targets = cancel
        .cancel_targets
        .iter()
        .map(|target| (target.thread_id.as_str(), target.turn_id.as_str()))
        .collect::<Vec<_>>();
    assert_eq!(
        cancel_targets,
        vec![
            ("office-thread-123456789", "turn-1"),
            ("member-thread-123456789", "member-turn-1"),
            ("automation-thread-123456789", "automation-turn-1"),
        ]
    );
    let (_, canceled) = processor
        .office_run_mark_cancel_requested(&cwd, cancel.config, &prepared.run_id, &cancel.turn_id)
        .await
        .expect("mark cancel requested");
    assert_eq!(
        canceled["workspace"]["activity"]["runs"][0]["status"],
        "canceling"
    );
    let canceled_run = &canceled["workspace"]["activity"]["runs"][0];
    assert_eq!(canceled_run["delegations"][0]["status"], "canceling");
    assert_eq!(canceled_run["delegations"][1]["status"], "completed");
    assert_eq!(
        canceled_run["verificationChecks"][0]["dispatchStatus"],
        "canceling"
    );
    assert_eq!(
        canceled_run["verificationChecks"][0]["automationStatus"],
        "canceling"
    );
    assert_eq!(
        canceled_run["verificationChecks"][1]["dispatchStatus"],
        "completed"
    );

    let retried = processor
        .office_run_retry_prepare(OfficeRunRetryParams {
            cwd: cwd.clone(),
            config: canceled,
            run_id: prepared.run_id.clone(),
            message: None,
            text: None,
            locale: Some("en".to_string()),
            client_user_message_id: Some("retry-message-1".to_string()),
        })
        .await
        .expect("prepare office run retry");
    assert_ne!(retried.run_id, prepared.run_id);
    assert_eq!(
        retried.client_user_message_id.as_deref(),
        Some("retry-message-1")
    );
    assert!(retried.prompt.contains("Run a retryable office task"));

    let index_path = temp_dir
        .path()
        .join(".crewon")
        .join("office-runs")
        .join("index.json");
    let index = std::fs::read_to_string(index_path).expect("read office run index");
    let index_json: serde_json::Value =
        serde_json::from_str(&index).expect("parse office run index");
    assert_eq!(index_json["runs"][0]["runId"], retried.run_id);
    assert_eq!(index_json["runs"][1]["runId"], prepared.run_id);
    assert_eq!(index_json["runs"][1]["turnId"], "turn-1");
}

#[tokio::test]
async fn office_child_cancel_only_marks_target_child() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let config = json!({
        "title": "Platform Office",
        "workspace": {
            "goal": "Ship the backend office",
            "threadId": "office-thread-123456789",
            "messages": [],
            "tasks": [],
            "activity": {
                "approvals": [],
                "artifacts": [],
                "runs": [{
                    "id": "office-run-child-cancel",
                    "title": "Run child tasks",
                    "status": "running",
                    "threadId": "office-thread-123456789",
                    "turnId": "manager-turn-1",
                    "delegations": [
                        {
                            "id": "delegation-running",
                            "member": "Reviewer",
                            "status": "running",
                            "threadId": "member-thread-123456789",
                            "turnId": "member-turn-1"
                        },
                        {
                            "id": "delegation-other",
                            "member": "Builder",
                            "status": "running",
                            "threadId": "builder-thread-123456789",
                            "turnId": "builder-turn-1"
                        }
                    ],
                    "verificationChecks": [
                        {
                            "itemId": "verification-running",
                            "check": "Run active automation",
                            "status": "pending",
                            "dispatchStatus": "running",
                            "automationStatus": "running",
                            "automationThreadId": "automation-thread-123456789",
                            "automationTurnId": "automation-turn-1"
                        }
                    ]
                }]
            }
        }
    });
    processor
        .office_save(OfficeSaveParams {
            cwd: cwd.clone(),
            config: config.clone(),
        })
        .await
        .expect("persist office config");

    let delegation_cancel = processor
        .office_delegation_cancel_prepare(OfficeDelegationCancelParams {
            cwd: cwd.clone(),
            config,
            run_id: "office-run-child-cancel".to_string(),
            delegation_id: "delegation-running".to_string(),
            thread_id: None,
            turn_id: None,
            locale: Some("en".to_string()),
        })
        .await
        .expect("prepare delegation cancel");
    assert_eq!(delegation_cancel.thread_id, "member-thread-123456789");
    assert_eq!(delegation_cancel.turn_id, "member-turn-1");
    let cancel_targets = delegation_cancel
        .cancel_targets
        .iter()
        .map(|target| (target.thread_id.as_str(), target.turn_id.as_str()))
        .collect::<Vec<_>>();
    assert_eq!(
        cancel_targets,
        vec![("member-thread-123456789", "member-turn-1")]
    );
    let (_, delegation_canceled) = processor
        .office_delegation_mark_cancel_requested(
            &cwd,
            delegation_cancel.config,
            "office-run-child-cancel",
            "delegation-running",
            "member-turn-1",
        )
        .await
        .expect("mark delegation cancel requested");
    let run = &delegation_canceled["workspace"]["activity"]["runs"][0];
    assert_eq!(run["status"], "running");
    assert_eq!(run["delegations"][0]["status"], "canceling");
    assert_eq!(run["delegations"][1]["status"], "running");
    assert_eq!(run["verificationChecks"][0]["dispatchStatus"], "running");

    let verification_cancel = processor
        .office_verification_cancel_prepare(OfficeVerificationCancelParams {
            cwd: cwd.clone(),
            config: delegation_canceled,
            run_id: "office-run-child-cancel".to_string(),
            verification_check_id: "verification-running".to_string(),
            thread_id: None,
            turn_id: None,
            locale: Some("en".to_string()),
        })
        .await
        .expect("prepare verification cancel");
    assert_eq!(verification_cancel.thread_id, "automation-thread-123456789");
    assert_eq!(verification_cancel.turn_id, "automation-turn-1");
    let (_, verification_canceled) = processor
        .office_verification_mark_cancel_requested(
            &cwd,
            verification_cancel.config,
            "office-run-child-cancel",
            "verification-running",
            "automation-turn-1",
        )
        .await
        .expect("mark verification cancel requested");
    let run = &verification_canceled["workspace"]["activity"]["runs"][0];
    assert_eq!(run["status"], "running");
    assert_eq!(run["delegations"][0]["status"], "canceling");
    assert_eq!(run["verificationChecks"][0]["dispatchStatus"], "canceling");
    assert_eq!(
        run["verificationChecks"][0]["automationStatus"],
        "canceling"
    );
}

#[tokio::test]
async fn office_run_sync_rejects_turn_id_mismatch() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let config = json!({
        "title": "Platform Office",
        "workspace": {
            "goal": "Ship the backend office",
            "threadId": "office-thread-123456789",
            "messages": [],
            "tasks": [],
            "activity": {
                "approvals": [],
                "artifacts": []
            }
        }
    });

    let prepared = processor
        .office_run_prepare(OfficeRunParams {
            cwd: cwd.clone(),
            config,
            message: json!({
                "author": "User",
                "text": "Finish office sync"
            }),
            text: "Finish office sync".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare office run");
    let (_, started_config) = processor
        .office_run_mark_started(&cwd, prepared.config, &prepared.run_id, "turn-1")
        .await
        .expect("mark office run started");
    let error = processor
        .office_run_sync(OfficeRunSyncParams {
            cwd,
            config: started_config,
            run_id: Some(prepared.run_id),
            turn: Turn {
                id: "turn-2".to_string(),
                items: Vec::new(),
                items_view: TurnItemsView::NotLoaded,
                status: TurnStatus::Completed,
                error: None,
                started_at: None,
                completed_at: None,
                duration_ms: None,
            },
            locale: None,
        })
        .await
        .expect_err("mismatched turn id should fail");

    assert_eq!(error.code, INVALID_PARAMS_ERROR_CODE);
    assert_eq!(error.message, "turn.id must match office run turnId");
}

#[tokio::test]
async fn office_run_auto_sync_scans_bound_office_and_is_idempotent() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let config = json!({
        "title": "Platform Office",
        "workspace": {
            "goal": "Ship the backend office",
            "threadId": "office-thread-123456789",
            "messages": [],
            "tasks": [],
            "activity": {
                "approvals": [],
                "artifacts": []
            }
        }
    });

    let prepared = processor
        .office_run_prepare(OfficeRunParams {
            cwd: cwd.clone(),
            config,
            message: json!({
                "author": "User",
                "glyph": "@",
                "accent": "slate",
                "time": "09:10",
                "kind": "message",
                "text": "Finish automatic office sync"
            }),
            text: "Finish automatic office sync".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare office run");
    processor
        .office_run_mark_started(&cwd, prepared.config, &prepared.run_id, "turn-1")
        .await
        .expect("mark office run started");
    let completed_turn = Turn {
        id: "turn-1".to_string(),
        items: vec![ThreadItem::AgentMessage {
            id: "agent-message-1".to_string(),
            text: "Automatic office sync is complete.".to_string(),
            phase: None,
            memory_citation: None,
        }],
        items_view: TurnItemsView::Full,
        status: TurnStatus::Completed,
        error: None,
        started_at: Some(1),
        completed_at: Some(2),
        duration_ms: Some(1_000),
    };

    let synced = sync_office_runs_for_thread_turn(&cwd, "office-thread-123456789", &completed_turn)
        .await
        .expect("auto sync office run");
    let synced_again =
        sync_office_runs_for_thread_turn(&cwd, "office-thread-123456789", &completed_turn)
            .await
            .expect("auto sync office run again");
    let read_response = processor
        .office_read(OfficeReadParams {
            cwd,
            thread_id: Some("office-thread-123456789".to_string()),
            title: None,
        })
        .await
        .expect("read office config");
    let config = read_response.record.expect("office record").config;

    assert_eq!(synced, 1);
    assert_eq!(synced_again, 1);
    assert_eq!(
        config["workspace"]["activity"]["runs"][0]["status"],
        "completed"
    );
    assert_eq!(
        config["workspace"]["activity"]["runs"][0]["resultPreview"],
        "Automatic office sync is complete."
    );
    assert_eq!(config["workspace"]["tasks"][0]["status"], "done");
    let sync_messages = config["workspace"]["messages"]
        .as_array()
        .expect("messages")
        .iter()
        .filter(|message| message.get("event").and_then(|event| event.as_str()) == Some("runSync"))
        .count();
    assert_eq!(sync_messages, 1);
}

#[tokio::test]
async fn office_run_auto_sync_marks_failed_turn_retryable() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    let config = json!({
        "title": "Platform Office",
        "workspace": {
            "goal": "Ship the backend office",
            "threadId": "office-thread-123456789",
            "messages": [],
            "tasks": [],
            "activity": {
                "approvals": [],
                "artifacts": []
            }
        }
    });

    let prepared = processor
        .office_run_prepare(OfficeRunParams {
            cwd: cwd.clone(),
            config,
            message: json!({
                "author": "User",
                "text": "Run a failing office sync"
            }),
            text: "Run a failing office sync".to_string(),
            locale: Some("en".to_string()),
            thread_id: None,
            client_user_message_id: None,
        })
        .await
        .expect("prepare office run");
    processor
        .office_run_mark_started(&cwd, prepared.config, &prepared.run_id, "turn-1")
        .await
        .expect("mark office run started");
    let failed_turn = Turn {
        id: "turn-1".to_string(),
        items: Vec::new(),
        items_view: TurnItemsView::NotLoaded,
        status: TurnStatus::Failed,
        error: Some(TurnError {
            message: "model failed".to_string(),
            codex_error_info: None,
            additional_details: None,
        }),
        started_at: Some(1),
        completed_at: Some(2),
        duration_ms: Some(1_000),
    };

    let synced = sync_office_runs_for_thread_turn(&cwd, "office-thread-123456789", &failed_turn)
        .await
        .expect("auto sync failed office run");
    let read_response = processor
        .office_read(OfficeReadParams {
            cwd,
            thread_id: Some("office-thread-123456789".to_string()),
            title: None,
        })
        .await
        .expect("read office config");
    let config = read_response.record.expect("office record").config;

    assert_eq!(synced, 1);
    assert_eq!(
        config["workspace"]["activity"]["runs"][0]["status"],
        "failed"
    );
    assert_eq!(
        config["workspace"]["activity"]["runs"][0]["error"],
        "model failed"
    );
    assert_eq!(config["workspace"]["tasks"][0]["status"], "todo");
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
async fn office_member_add_resolves_runtime_from_saved_agent() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    processor
        .agent_save(AgentSaveParams {
            cwd: cwd.clone(),
            config: json!({
                "agentId": "agent-reviewer",
                "name": "Reviewer",
                "threadId": "reviewer-thread-123456789",
                "role": "Code review"
            }),
        })
        .await
        .expect("save reviewer agent");
    let config = json!({
        "title": "Platform Office",
        "workspace": {
            "threadId": "office-thread-123456789",
            "members": []
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
                    "role": "Code review",
                    "runtime": {
                        "threadId": "reviewer-thread-123456789",
                        "contextPolicy": "sharedDigest",
                        "memoryScope": "privateAndShared",
                        "agentProfile": "role=Code review"
                    }
                }
            ]
        }
    });
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
async fn office_artifact_upsert_records_file_content_observation() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let cwd = temp_dir.path().to_string_lossy().into_owned();
    tokio::fs::write(temp_dir.path().join("artifact.md"), b"artifact body")
        .await
        .expect("write artifact file");
    let config = json!({
        "title": "Platform Office",
        "workspace": {
            "threadId": "office-thread-123456789",
            "activity": { "artifacts": [] }
        }
    });

    let upsert_response = processor
        .office_artifact_upsert(OfficeArtifactUpsertParams {
            cwd,
            config,
            artifact: json!({
                "title": "Artifact File",
                "kind": "markdown",
                "glyph": "#",
                "accent": "blue",
                "meta": "saved",
                "path": "artifact.md"
            }),
            message: None,
        })
        .await
        .expect("upsert office artifact");

    let mut artifact = upsert_response.config["workspace"]["activity"]["artifacts"][0].clone();
    let observed_at = artifact
        .as_object_mut()
        .expect("artifact object")
        .remove("contentObservedAt")
        .expect("content observed at");
    assert!(
        observed_at
            .as_str()
            .is_some_and(|observed_at| !observed_at.trim().is_empty())
    );
    assert_eq!(
        artifact,
        json!({
            "title": "Artifact File",
            "kind": "markdown",
            "glyph": "#",
            "accent": "blue",
            "meta": "saved",
            "path": "artifact.md",
            "contentSource": "file",
            "contentStatus": "fingerprinted",
            "contentSha256": sha256_hex(b"artifact body"),
            "contentBytes": "artifact body".len()
        })
    );
}

#[tokio::test]
async fn office_artifact_upsert_marks_missing_file_and_clears_stale_fingerprint() {
    let temp_dir = TempDir::new().expect("create temp dir");
    let processor = CrewonDomainRequestProcessor::new();
    let config = json!({
        "title": "Platform Office",
        "workspace": {
            "threadId": "office-thread-123456789",
            "activity": { "artifacts": [] }
        }
    });

    let upsert_response = processor
        .office_artifact_upsert(OfficeArtifactUpsertParams {
            cwd: temp_dir.path().to_string_lossy().into_owned(),
            config,
            artifact: json!({
                "title": "Missing Artifact",
                "kind": "markdown",
                "glyph": "#",
                "accent": "blue",
                "meta": "saved",
                "path": "missing.md",
                "contentSha256": "stale",
                "contentBytes": 42
            }),
            message: None,
        })
        .await
        .expect("upsert office artifact");

    let mut artifact = upsert_response.config["workspace"]["activity"]["artifacts"][0].clone();
    let observed_at = artifact
        .as_object_mut()
        .expect("artifact object")
        .remove("contentObservedAt")
        .expect("content observed at");
    assert!(
        observed_at
            .as_str()
            .is_some_and(|observed_at| !observed_at.trim().is_empty())
    );
    let content_error = artifact
        .as_object_mut()
        .expect("artifact object")
        .remove("contentError")
        .expect("content error");
    assert!(
        content_error
            .as_str()
            .is_some_and(|error| error.starts_with("canonicalize failed:"))
    );
    assert_eq!(
        artifact,
        json!({
            "title": "Missing Artifact",
            "kind": "markdown",
            "glyph": "#",
            "accent": "blue",
            "meta": "saved",
            "path": "missing.md",
            "contentSource": "file",
            "contentStatus": "missing"
        })
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
