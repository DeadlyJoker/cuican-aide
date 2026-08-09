use std::time::Duration;

use anyhow::Result;
use app_test_support::TestAppServer;
use app_test_support::create_final_assistant_message_sse_response;
use app_test_support::create_mock_responses_server_sequence_unchecked;
use app_test_support::create_mock_responses_server_sequence_unchecked_with_delays;
use app_test_support::to_response;
use app_test_support::write_mock_responses_config_toml_with_chatgpt_base_url;
use crewon_app_server_protocol::AgentCreateParams;
use crewon_app_server_protocol::AgentCreateResponse;
use crewon_app_server_protocol::JSONRPCResponse;
use crewon_app_server_protocol::RequestId;
use crewon_app_server_protocol::WorkflowCreateParams;
use crewon_app_server_protocol::WorkflowCreateResponse;
use crewon_app_server_protocol::WorkflowDeleteParams;
use crewon_app_server_protocol::WorkflowDeleteResponse;
use crewon_app_server_protocol::WorkflowGateDecision;
use crewon_app_server_protocol::WorkflowGateResolveParams;
use crewon_app_server_protocol::WorkflowGateResolveResponse;
use crewon_app_server_protocol::WorkflowListParams;
use crewon_app_server_protocol::WorkflowListResponse;
use crewon_app_server_protocol::WorkflowNodeDefinition;
use crewon_app_server_protocol::WorkflowReadParams;
use crewon_app_server_protocol::WorkflowReadResponse;
use crewon_app_server_protocol::WorkflowRunCancelParams;
use crewon_app_server_protocol::WorkflowRunCancelResponse;
use crewon_app_server_protocol::WorkflowRunParams;
use crewon_app_server_protocol::WorkflowRunResponse;
use pretty_assertions::assert_eq;
use serde::de::DeserializeOwned;
use serde_json::json;
use tempfile::TempDir;
use tokio::time::timeout;

const TIMEOUT: Duration = Duration::from_secs(30);

async fn initialized_app_server(codex_home: &TempDir) -> Result<TestAppServer> {
    let mut app = TestAppServer::new(codex_home.path()).await?;
    timeout(TIMEOUT, app.initialize()).await??;
    Ok(app)
}

async fn request<T: DeserializeOwned>(
    app: &mut TestAppServer,
    method: &str,
    params: impl serde::Serialize,
) -> Result<T> {
    let request_id = app
        .send_raw_request(method, Some(serde_json::to_value(params)?))
        .await?;
    let response: JSONRPCResponse = timeout(
        TIMEOUT,
        app.read_stream_until_response_message(RequestId::Integer(request_id)),
    )
    .await??;
    to_response(response)
}

async fn create_local_agent(
    app: &mut TestAppServer,
    cwd: &str,
    name: &str,
    role: &str,
) -> Result<AgentCreateResponse> {
    request(
        app,
        "agent/create",
        AgentCreateParams {
            cwd: cwd.to_string(),
            config: json!({
                "name": name,
                "role": role,
                "model": "mock-model",
                "permission": "read-only",
            }),
        },
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_workflow_uses_durable_local_agent_threads_and_advances_in_order() -> Result<()> {
    let responses = create_mock_responses_server_sequence_unchecked(vec![
        create_final_assistant_message_sse_response("风险清单：付款条款缺失")?,
        create_final_assistant_message_sse_response("交付结论：补齐付款条款后通过")?,
    ])
    .await;
    let codex_home = TempDir::new()?;
    write_mock_responses_config_toml_with_chatgpt_base_url(
        codex_home.path(),
        &responses.uri(),
        &responses.uri(),
    )?;
    let workspace = TempDir::new()?;
    let cwd = workspace.path().to_string_lossy().into_owned();
    let mut app = initialized_app_server(&codex_home).await?;
    let reviewer = create_local_agent(&mut app, &cwd, "Review Agent", "风险审阅").await?;
    let deliverer = create_local_agent(&mut app, &cwd, "Delivery Agent", "交付确认").await?;

    let created: WorkflowCreateResponse = request(
        &mut app,
        "workflow/create",
        WorkflowCreateParams {
            cwd: cwd.clone(),
            name: "交付验收".to_string(),
            description: "审阅后给出交付结论".to_string(),
            lead: "审阅智能体".to_string(),
            nodes: vec![
                WorkflowNodeDefinition::Agent {
                    title: "风险审阅".to_string(),
                    agent_id: reviewer.agent_id.clone(),
                    agent_name: "审阅智能体".to_string(),
                    instruction: "列出关键风险".to_string(),
                },
                WorkflowNodeDefinition::Agent {
                    title: "交付确认".to_string(),
                    agent_id: deliverer.agent_id.clone(),
                    agent_name: "交付智能体".to_string(),
                    instruction: "基于风险清单给出结论".to_string(),
                },
            ],
        },
    )
    .await?;
    let workflow_id = created.config["workflowId"]
        .as_str()
        .expect("workflow id")
        .to_string();
    assert!(created.file_path.contains(".crewon/workflows/"));

    let listed: WorkflowListResponse = request(
        &mut app,
        "workflow/list",
        WorkflowListParams {
            cwd: cwd.clone(),
            cursor: None,
            limit: Some(100),
        },
    )
    .await?;
    assert_eq!(listed.data.len(), 1);
    assert_eq!(listed.data[0].config, created.config);

    let started: WorkflowRunResponse = request(
        &mut app,
        "workflow/run",
        WorkflowRunParams {
            cwd: cwd.clone(),
            workflow_id: workflow_id.clone(),
            input: "审阅交付风险".to_string(),
        },
    )
    .await?;
    assert_eq!(started.workflow_id, workflow_id);
    assert_eq!(started.status, "running");
    assert_eq!(started.executed_nodes[0].status, "running");
    assert_eq!(started.executed_nodes[1].status, "pending");

    timeout(
        TIMEOUT,
        app.read_stream_until_matching_notification(
            "completed local workflow run",
            |notification| {
                notification.method == "workflow/run/updated"
                    && notification
                        .params
                        .as_ref()
                        .and_then(|params| params.get("config"))
                        .and_then(|config| config.get("status"))
                        .and_then(serde_json::Value::as_str)
                        == Some("ready")
            },
        ),
    )
    .await??;

    let read: WorkflowReadResponse = request(
        &mut app,
        "workflow/read",
        WorkflowReadParams {
            cwd: cwd.clone(),
            workflow_id: workflow_id.clone(),
        },
    )
    .await?;
    let config = read.record.expect("persisted workflow").config;
    let run = &config["runs"][0];
    assert_eq!(config["status"], "ready");
    assert_eq!(run["status"], "completed");
    assert_eq!(run["output"], "交付结论：补齐付款条款后通过");
    assert_eq!(run["executedNodes"][0]["output"], "风险清单：付款条款缺失");
    assert_eq!(run["executedNodes"][1]["agentId"], deliverer.agent_id);
    assert!(run["executedNodes"][0]["threadId"].as_str().is_some());
    assert!(run["executedNodes"][1]["threadId"].as_str().is_some());

    let deleted: WorkflowDeleteResponse = request(
        &mut app,
        "workflow/delete",
        WorkflowDeleteParams {
            cwd,
            file_path: created.file_path,
        },
    )
    .await?;
    assert_eq!(deleted, WorkflowDeleteResponse { deleted: true });
    assert_eq!(
        responses
            .received_requests()
            .await
            .expect("request journal")
            .len(),
        2
    );
    app.shutdown().await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_workflow_waits_for_human_gate_then_resumes_or_cancels_locally() -> Result<()> {
    let responses = create_mock_responses_server_sequence_unchecked_with_delays(vec![
        (
            create_final_assistant_message_sse_response("风险清单：需要人工确认发布范围")?,
            Duration::ZERO,
        ),
        (
            create_final_assistant_message_sse_response("交付完成：已按批准范围发布")?,
            Duration::ZERO,
        ),
        (
            create_final_assistant_message_sse_response("取消后不应成为协作流结果")?,
            Duration::from_secs(/*secs*/ 5),
        ),
    ])
    .await;
    let codex_home = TempDir::new()?;
    write_mock_responses_config_toml_with_chatgpt_base_url(
        codex_home.path(),
        &responses.uri(),
        &responses.uri(),
    )?;
    let workspace = TempDir::new()?;
    let cwd = workspace.path().to_string_lossy().into_owned();
    let mut app = initialized_app_server(&codex_home).await?;
    let reviewer = create_local_agent(&mut app, &cwd, "Review Agent", "风险审阅").await?;
    let deliverer = create_local_agent(&mut app, &cwd, "Delivery Agent", "交付执行").await?;

    let created: WorkflowCreateResponse = request(
        &mut app,
        "workflow/create",
        WorkflowCreateParams {
            cwd: cwd.clone(),
            name: "人工确认交付".to_string(),
            description: "审阅后等待人工确认再交付".to_string(),
            lead: "审阅智能体".to_string(),
            nodes: vec![
                WorkflowNodeDefinition::Agent {
                    title: "风险审阅".to_string(),
                    agent_id: reviewer.agent_id.clone(),
                    agent_name: "审阅智能体".to_string(),
                    instruction: "列出发布风险".to_string(),
                },
                WorkflowNodeDefinition::HumanGate {
                    title: "发布范围确认".to_string(),
                    instruction: "确认风险清单和发布范围".to_string(),
                },
                WorkflowNodeDefinition::Agent {
                    title: "交付执行".to_string(),
                    agent_id: deliverer.agent_id.clone(),
                    agent_name: "交付智能体".to_string(),
                    instruction: "只按人工批准范围交付".to_string(),
                },
            ],
        },
    )
    .await?;
    let workflow_id = created.config["workflowId"]
        .as_str()
        .expect("workflow id")
        .to_string();
    let started: WorkflowRunResponse = request(
        &mut app,
        "workflow/run",
        WorkflowRunParams {
            cwd: cwd.clone(),
            workflow_id: workflow_id.clone(),
            input: "检查并发布".to_string(),
        },
    )
    .await?;

    timeout(
        TIMEOUT,
        app.read_stream_until_matching_notification("workflow human gate", |notification| {
            notification.method == "workflow/run/updated"
                && notification
                    .params
                    .as_ref()
                    .and_then(|params| params.get("config"))
                    .and_then(|config| config.get("status"))
                    .and_then(serde_json::Value::as_str)
                    == Some("waitingForApproval")
        }),
    )
    .await??;

    let approved: WorkflowGateResolveResponse = request(
        &mut app,
        "workflow/gate/resolve",
        WorkflowGateResolveParams {
            cwd: cwd.clone(),
            workflow_id: workflow_id.clone(),
            execution_id: started.execution_id,
            node_id: "node-2".to_string(),
            decision: WorkflowGateDecision::Approve,
            comment: Some("仅发布已审阅范围".to_string()),
        },
    )
    .await?;
    assert_eq!(approved.status, "running");
    assert_eq!(approved.executed_nodes[1].status, "completed");

    timeout(
        TIMEOUT,
        app.read_stream_until_matching_notification(
            "completed gated workflow run",
            |notification| {
                notification.method == "workflow/run/updated"
                    && notification
                        .params
                        .as_ref()
                        .and_then(|params| params.get("config"))
                        .and_then(|config| config.get("runs"))
                        .and_then(|runs| runs.get(0))
                        .and_then(|run| run.get("status"))
                        .and_then(serde_json::Value::as_str)
                        == Some("completed")
            },
        ),
    )
    .await??;
    let completed: WorkflowReadResponse = request(
        &mut app,
        "workflow/read",
        WorkflowReadParams {
            cwd: cwd.clone(),
            workflow_id: workflow_id.clone(),
        },
    )
    .await?;
    let completed_config = completed.record.expect("persisted workflow").config;
    assert_eq!(
        completed_config["runs"][0]["executedNodes"][1]["decision"],
        "approved"
    );
    assert_eq!(
        completed_config["runs"][0]["executedNodes"][1]["comment"],
        "仅发布已审阅范围"
    );
    assert_eq!(
        completed_config["runs"][0]["output"],
        "交付完成：已按批准范围发布"
    );

    let cancel_workflow: WorkflowCreateResponse = request(
        &mut app,
        "workflow/create",
        WorkflowCreateParams {
            cwd: cwd.clone(),
            name: "可取消审阅".to_string(),
            description: "验证本地运行取消".to_string(),
            lead: "审阅智能体".to_string(),
            nodes: vec![WorkflowNodeDefinition::Agent {
                title: "长时间审阅".to_string(),
                agent_id: reviewer.agent_id,
                agent_name: "审阅智能体".to_string(),
                instruction: "等待后给出结论".to_string(),
            }],
        },
    )
    .await?;
    let cancel_workflow_id = cancel_workflow.config["workflowId"]
        .as_str()
        .expect("cancel workflow id")
        .to_string();
    let cancel_started: WorkflowRunResponse = request(
        &mut app,
        "workflow/run",
        WorkflowRunParams {
            cwd: cwd.clone(),
            workflow_id: cancel_workflow_id.clone(),
            input: "开始后立即取消".to_string(),
        },
    )
    .await?;
    let canceled: WorkflowRunCancelResponse = request(
        &mut app,
        "workflow/run/cancel",
        WorkflowRunCancelParams {
            cwd: cwd.clone(),
            workflow_id: cancel_workflow_id,
            execution_id: cancel_started.execution_id,
        },
    )
    .await?;
    assert_eq!(canceled.status, "canceled");
    assert_eq!(canceled.executed_nodes[0].status, "canceled");
    assert_eq!(canceled.error, None);

    let gate_only: WorkflowCreateResponse = request(
        &mut app,
        "workflow/create",
        WorkflowCreateParams {
            cwd: cwd.clone(),
            name: "人工发布确认".to_string(),
            description: "未通过时停止".to_string(),
            lead: "发布负责人".to_string(),
            nodes: vec![WorkflowNodeDefinition::HumanGate {
                title: "发布确认".to_string(),
                instruction: "确认是否允许发布".to_string(),
            }],
        },
    )
    .await?;
    let gate_only_id = gate_only.config["workflowId"]
        .as_str()
        .expect("gate-only workflow id")
        .to_string();
    let gate_waiting: WorkflowRunResponse = request(
        &mut app,
        "workflow/run",
        WorkflowRunParams {
            cwd: cwd.clone(),
            workflow_id: gate_only_id.clone(),
            input: "准备发布".to_string(),
        },
    )
    .await?;
    assert_eq!(gate_waiting.status, "waitingForApproval");
    let rejected: WorkflowGateResolveResponse = request(
        &mut app,
        "workflow/gate/resolve",
        WorkflowGateResolveParams {
            cwd,
            workflow_id: gate_only_id,
            execution_id: gate_waiting.execution_id,
            node_id: "node-1".to_string(),
            decision: WorkflowGateDecision::Reject,
            comment: Some("验收证据不足".to_string()),
        },
    )
    .await?;
    assert_eq!(rejected.status, "rejected");
    assert_eq!(
        rejected.config["runs"][0]["executedNodes"][0]["decision"],
        "rejected"
    );
    assert_eq!(
        rejected.config["runs"][0]["executedNodes"][0]["comment"],
        "验收证据不足"
    );
    app.shutdown().await?;
    Ok(())
}
