use chrono::Utc;
use crewon_app_server_protocol::JSONRPCErrorError;
use crewon_app_server_protocol::ThreadItem;
use crewon_app_server_protocol::Turn;
use crewon_app_server_protocol::TurnStatus;
use crewon_app_server_protocol::WorkflowCreateParams;
use crewon_app_server_protocol::WorkflowCreateResponse;
use crewon_app_server_protocol::WorkflowDeleteParams;
use crewon_app_server_protocol::WorkflowDeleteResponse;
use crewon_app_server_protocol::WorkflowListParams;
use crewon_app_server_protocol::WorkflowListResponse;
use crewon_app_server_protocol::WorkflowNodeDefinition;
use crewon_app_server_protocol::WorkflowNodeExecution;
use crewon_app_server_protocol::WorkflowReadParams;
use crewon_app_server_protocol::WorkflowReadResponse;
use crewon_app_server_protocol::WorkflowRunParams;
use crewon_app_server_protocol::WorkflowRunResponse;
use serde_json::Value as JsonValue;
use serde_json::json;
use std::collections::HashMap;
use uuid::Uuid;

use crate::error_code::invalid_params;

use super::CrewonDomainRequestProcessor;
use super::DomainKind;
use super::MAX_LIST_LIMIT;
use super::create_record;
use super::delete_record;
use super::list_records;
use super::read_agent_record;
use super::update_record;

const MAX_WORKFLOW_NODES: usize = 20;
const MAX_NAME_CHARS: usize = 120;
const MAX_DESCRIPTION_CHARS: usize = 2_000;
const MAX_INSTRUCTION_CHARS: usize = 2_000;
const MAX_INPUT_CHARS: usize = 10_000;
const MAX_OUTPUT_CHARS: usize = 10_000;
const MAX_RUNS: usize = 20;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PreparedWorkflowNodeDispatch {
    pub(crate) cwd: String,
    pub(crate) file_path: String,
    pub(crate) run_id: String,
    pub(crate) node_id: String,
    pub(crate) agent_id: String,
    pub(crate) thread_id: String,
    pub(crate) prompt: String,
}

#[derive(Clone, Debug)]
pub(crate) struct PreparedWorkflowRun {
    pub(crate) cwd: String,
    pub(crate) file_path: String,
    pub(crate) update: WorkflowRunUpdate,
    pub(crate) next: Option<PreparedWorkflowNodeDispatch>,
}

#[derive(Clone, Debug)]
pub(crate) struct WorkflowTerminalTransition {
    pub(crate) file_path: String,
    pub(crate) config: JsonValue,
    pub(crate) next: Option<PreparedWorkflowNodeDispatch>,
}

#[derive(Clone, Debug)]
pub(crate) struct WorkflowRunUpdate {
    pub(crate) response: WorkflowRunResponse,
    pub(crate) config: JsonValue,
}

#[derive(Clone, Debug)]
struct ConfiguredWorkflowNode {
    node_id: String,
    node_type: ConfiguredWorkflowNodeType,
    title: String,
    instruction: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum ConfiguredWorkflowNodeType {
    Agent {
        agent_id: String,
        agent_name: String,
    },
    HumanGate,
}

#[path = "crewon_domain_workflow_recovery.rs"]
mod recovery;

#[path = "crewon_domain_workflow_control.rs"]
mod control;

#[path = "crewon_domain_workflow_definition.rs"]
mod definition;
use definition::node_message;
use definition::node_type_name;
use definition::parse_nodes;
use definition::validate_create;
use definition::validate_text;
use definition::workflow_node_config;

impl CrewonDomainRequestProcessor {
    pub(crate) async fn workflow_list(
        &self,
        params: WorkflowListParams,
    ) -> Result<WorkflowListResponse, JSONRPCErrorError> {
        list_records(
            DomainKind::Workflow,
            &params.cwd,
            params.cursor,
            params.limit,
        )
        .await
        .map(|(data, next_cursor)| WorkflowListResponse { data, next_cursor })
    }

    pub(crate) async fn workflow_create(
        &self,
        params: WorkflowCreateParams,
    ) -> Result<WorkflowCreateResponse, JSONRPCErrorError> {
        validate_create(&params)?;
        for node in &params.nodes {
            if let WorkflowNodeDefinition::Agent { agent_id, .. } = node
                && read_agent_record(
                    &params.cwd,
                    Some(agent_id),
                    /*thread_id*/ None,
                    /*name*/ None,
                )
                .await?
                .is_none()
            {
                return Err(invalid_params(format!(
                    "Workflow node agent does not exist in the current workspace: {agent_id}"
                )));
            }
        }
        let now = Utc::now().timestamp();
        let config = json!({
            "workflowId": Uuid::now_v7().to_string(),
            "name": params.name.trim(),
            "description": params.description.trim(),
            "lead": params.lead.trim(),
            "status": "ready",
            "resourceSource": "crewon",
            "createdAt": now,
            "updatedAt": now,
            "runs": [],
            "nodes": params.nodes.into_iter().enumerate().map(workflow_node_config).collect::<Vec<_>>(),
        });
        let file_path = create_record(DomainKind::Workflow, &params.cwd, config.clone()).await?;
        Ok(WorkflowCreateResponse { file_path, config })
    }

    pub(crate) async fn workflow_read(
        &self,
        params: WorkflowReadParams,
    ) -> Result<WorkflowReadResponse, JSONRPCErrorError> {
        let record = read_workflow(&params.cwd, &params.workflow_id).await?;
        Ok(WorkflowReadResponse { record })
    }

    pub(crate) async fn workflow_run_prepare(
        &self,
        params: WorkflowRunParams,
        runtime_threads: &HashMap<String, String>,
    ) -> Result<PreparedWorkflowRun, JSONRPCErrorError> {
        let input = validate_text(&params.input, MAX_INPUT_CHARS, "input")?;
        let record = read_workflow(&params.cwd, &params.workflow_id)
            .await?
            .ok_or_else(|| invalid_params("Workflow does not exist in the current workspace"))?;
        let nodes = parse_nodes(&record.config)?;
        if workflow_has_active_run(&record.config) {
            return Err(invalid_params(
                "Workflow already has an active local run; wait for it to finish or cancel it",
            ));
        }
        for node in &nodes {
            let ConfiguredWorkflowNodeType::Agent { agent_id, .. } = &node.node_type else {
                continue;
            };
            if !runtime_threads.contains_key(agent_id) {
                return Err(invalid_params(format!(
                    "Workflow node has no local runtime thread: {agent_id}"
                )));
            }
        }
        let description = record
            .config
            .get("description")
            .and_then(JsonValue::as_str)
            .unwrap_or_default()
            .to_string();
        let run_id = format!("workflow-run-{}", Uuid::now_v7());
        let now = Utc::now().timestamp();
        let executed_nodes = nodes
            .iter()
            .enumerate()
            .map(|(index, node)| {
                let (agent_id, agent_name, thread_id) = match &node.node_type {
                    ConfiguredWorkflowNodeType::Agent {
                        agent_id,
                        agent_name,
                    } => (
                        JsonValue::String(agent_id.clone()),
                        JsonValue::String(agent_name.clone()),
                        runtime_threads
                            .get(agent_id)
                            .cloned()
                            .map_or(JsonValue::Null, JsonValue::String),
                    ),
                    ConfiguredWorkflowNodeType::HumanGate => {
                        (JsonValue::Null, JsonValue::Null, JsonValue::Null)
                    }
                };
                let first_status = if index == 0 {
                    match &node.node_type {
                        ConfiguredWorkflowNodeType::Agent { .. } => "queued",
                        ConfiguredWorkflowNodeType::HumanGate => "waitingForApproval",
                    }
                } else {
                    "pending"
                };
                json!({
                    "nodeId": node.node_id,
                    "type": node_type_name(&node.node_type),
                    "title": node.title,
                    "agentId": agent_id,
                    "agentName": agent_name,
                    "status": first_status,
                    "input": if index == 0 { input.as_str() } else { "" },
                    "output": "",
                    "error": null,
                    "decision": null,
                    "comment": null,
                    "threadId": thread_id,
                    "turnId": null,
                    "startedAt": if index == 0 { Some(now) } else { None },
                    "completedAt": null,
                    "resolvedAt": null,
                })
            })
            .collect::<Vec<_>>();
        let mut config = record.config;
        let config_object = config
            .as_object_mut()
            .ok_or_else(|| invalid_params("Workflow config must be an object"))?;
        let initial_status = match nodes.first().map(|node| &node.node_type) {
            Some(ConfiguredWorkflowNodeType::HumanGate) => "waitingForApproval",
            _ => "running",
        };
        config_object.insert(
            "status".to_string(),
            JsonValue::String(initial_status.to_string()),
        );
        config_object.insert("updatedAt".to_string(), json!(now));
        let runs = config_object
            .entry("runs")
            .or_insert_with(|| JsonValue::Array(Vec::new()));
        let runs = runs
            .as_array_mut()
            .ok_or_else(|| invalid_params("Workflow runs must be an array"))?;
        runs.insert(
            0,
            json!({
                "executionId": run_id,
                "status": if initial_status == "waitingForApproval" { initial_status } else { "queued" },
                "input": input,
                "output": "",
                "error": null,
                "createdAt": now,
                "updatedAt": now,
                "executedNodes": executed_nodes,
            }),
        );
        runs.truncate(MAX_RUNS);
        update_record(
            DomainKind::Workflow,
            &params.cwd,
            &record.file_path,
            config.clone(),
        )
        .await?;
        let first = nodes
            .first()
            .ok_or_else(|| invalid_params("Workflow has no nodes"))?;
        let update = WorkflowRunUpdate {
            response: workflow_run_response(&config, &run_id)?,
            config,
        };
        let next = match &first.node_type {
            ConfiguredWorkflowNodeType::Agent { agent_id, .. } => {
                Some(PreparedWorkflowNodeDispatch {
                    cwd: params.cwd.clone(),
                    file_path: record.file_path.clone(),
                    run_id: run_id.clone(),
                    node_id: first.node_id.clone(),
                    agent_id: agent_id.clone(),
                    thread_id: runtime_threads[agent_id].clone(),
                    prompt: node_message(&description, first, &input),
                })
            }
            ConfiguredWorkflowNodeType::HumanGate => None,
        };
        Ok(PreparedWorkflowRun {
            cwd: params.cwd,
            file_path: record.file_path,
            update,
            next,
        })
    }

    pub(crate) async fn workflow_run_mark_started(
        &self,
        prepared: &PreparedWorkflowNodeDispatch,
        turn_id: &str,
    ) -> Result<WorkflowRunUpdate, JSONRPCErrorError> {
        let config = mutate_workflow_run_node(
            &prepared.cwd,
            &prepared.file_path,
            &prepared.run_id,
            &prepared.node_id,
            |config, run, node| {
                let now = Utc::now().timestamp();
                set_string(run, "status", "running");
                run.insert("updatedAt".to_string(), json!(now));
                set_string(node, "status", "running");
                set_string(node, "threadId", &prepared.thread_id);
                set_string(node, "turnId", turn_id);
                node.insert("startedAt".to_string(), json!(now));
                let config_object = config
                    .as_object_mut()
                    .ok_or_else(|| invalid_params("Workflow config must be an object"))?;
                set_string(config_object, "status", "running");
                config_object.insert("updatedAt".to_string(), json!(now));
                Ok(())
            },
        )
        .await?;
        let response = workflow_run_response(&config, &prepared.run_id)?;
        Ok(WorkflowRunUpdate { response, config })
    }

    pub(crate) async fn workflow_run_rebind_thread(
        &self,
        prepared: &mut PreparedWorkflowNodeDispatch,
        thread_id: String,
    ) -> Result<(), JSONRPCErrorError> {
        if prepared.thread_id == thread_id {
            return Ok(());
        }
        mutate_workflow_run_node(
            &prepared.cwd,
            &prepared.file_path,
            &prepared.run_id,
            &prepared.node_id,
            |config, run, node| {
                let now = Utc::now().timestamp();
                set_string(node, "threadId", &thread_id);
                run.insert("updatedAt".to_string(), json!(now));
                let config_object = config
                    .as_object_mut()
                    .ok_or_else(|| invalid_params("Workflow config must be an object"))?;
                config_object.insert("updatedAt".to_string(), json!(now));
                Ok(())
            },
        )
        .await?;
        prepared.thread_id = thread_id;
        Ok(())
    }

    pub(crate) async fn workflow_run_mark_failed(
        &self,
        prepared: &PreparedWorkflowNodeDispatch,
        message: &str,
    ) -> Result<JsonValue, JSONRPCErrorError> {
        let message = truncate_chars(message, MAX_OUTPUT_CHARS);
        mutate_workflow_run_node(
            &prepared.cwd,
            &prepared.file_path,
            &prepared.run_id,
            &prepared.node_id,
            |config, run, node| {
                let now = Utc::now().timestamp();
                set_string(run, "status", "failed");
                set_string(run, "error", &message);
                run.insert("updatedAt".to_string(), json!(now));
                set_string(node, "status", "failed");
                set_string(node, "error", &message);
                node.insert("completedAt".to_string(), json!(now));
                let config_object = config
                    .as_object_mut()
                    .ok_or_else(|| invalid_params("Workflow config must be an object"))?;
                set_string(config_object, "status", "ready");
                config_object.insert("updatedAt".to_string(), json!(now));
                Ok(())
            },
        )
        .await
    }

    pub(crate) async fn workflow_sync_terminal_turn(
        &self,
        cwd: &str,
        thread_id: &str,
        turn: &Turn,
    ) -> Result<Vec<WorkflowTerminalTransition>, JSONRPCErrorError> {
        if !turn_status_is_terminal(&turn.status) {
            return Ok(Vec::new());
        }
        let (records, _) = list_records(
            DomainKind::Workflow,
            cwd,
            /*cursor*/ None,
            /*limit*/ Some(MAX_LIST_LIMIT as u32),
        )
        .await?;
        let mut transitions = Vec::new();
        for record in records {
            let Some((run_id, node_id)) = matching_active_node(&record.config, thread_id, &turn.id)
            else {
                continue;
            };
            let output = last_agent_message(turn)
                .map(|message| truncate_chars(message, MAX_OUTPUT_CHARS))
                .unwrap_or_default();
            let turn_error = turn
                .error
                .as_ref()
                .map(|error| truncate_chars(&error.message, MAX_OUTPUT_CHARS));
            let description = record
                .config
                .get("description")
                .and_then(JsonValue::as_str)
                .unwrap_or_default()
                .to_string();
            let mut next = None;
            let config = mutate_workflow_run_node(
                cwd,
                &record.file_path,
                &run_id,
                &node_id,
                |config, run, node| {
                    let now = Utc::now().timestamp();
                    node.insert("completedAt".to_string(), json!(now));
                    set_string(node, "output", &output);
                    match turn.status {
                        TurnStatus::Completed => {
                            set_string(node, "status", "completed");
                            node.insert("error".to_string(), JsonValue::Null);
                            next = control::advance_completed_node(control::WorkflowNodeAdvance {
                                config,
                                run,
                                current_node_id: &node_id,
                                output: &output,
                                cwd,
                                file_path: &record.file_path,
                                run_id: &run_id,
                                description: &description,
                            })?;
                        }
                        TurnStatus::Interrupted => {
                            set_string(node, "status", "interrupted");
                            set_string(run, "status", "interrupted");
                            let message = turn_error
                                .clone()
                                .unwrap_or_else(|| "Workflow node was interrupted".to_string());
                            set_string(node, "error", &message);
                            set_string(run, "error", &message);
                            run.insert("updatedAt".to_string(), json!(now));
                        }
                        TurnStatus::Failed => {
                            set_string(node, "status", "failed");
                            set_string(run, "status", "failed");
                            let message = turn_error
                                .clone()
                                .unwrap_or_else(|| "Workflow node failed".to_string());
                            set_string(node, "error", &message);
                            set_string(run, "error", &message);
                            run.insert("updatedAt".to_string(), json!(now));
                        }
                        TurnStatus::InProgress => unreachable!("terminal status checked above"),
                    }
                    let config_object = config
                        .as_object_mut()
                        .ok_or_else(|| invalid_params("Workflow config must be an object"))?;
                    set_string(config_object, "status", control::config_status_for_run(run));
                    config_object.insert("updatedAt".to_string(), json!(now));
                    Ok(())
                },
            )
            .await?;
            transitions.push(WorkflowTerminalTransition {
                file_path: record.file_path,
                config,
                next,
            });
        }
        Ok(transitions)
    }

    pub(crate) async fn workflow_delete(
        &self,
        params: WorkflowDeleteParams,
    ) -> Result<WorkflowDeleteResponse, JSONRPCErrorError> {
        delete_record(DomainKind::Workflow, &params.cwd, &params.file_path)
            .await
            .map(|deleted| WorkflowDeleteResponse { deleted })
    }
}

async fn read_workflow(
    cwd: &str,
    workflow_id: &str,
) -> Result<Option<crewon_app_server_protocol::CrewonDomainConfigRecord>, JSONRPCErrorError> {
    let workflow_id = validate_text(workflow_id, 128, "workflowId")?;
    let (records, _) = list_records(
        DomainKind::Workflow,
        cwd,
        /*cursor*/ None,
        /*limit*/ Some(MAX_LIST_LIMIT as u32),
    )
    .await?;
    Ok(records.into_iter().find(|record| {
        record.config.get("workflowId").and_then(JsonValue::as_str) == Some(workflow_id.as_str())
    }))
}

fn string_field(value: &JsonValue, field: &str) -> Result<String, JSONRPCErrorError> {
    value
        .get(field)
        .and_then(JsonValue::as_str)
        .map(str::to_string)
        .ok_or_else(|| invalid_params(format!("Workflow node {field} is missing")))
}

fn workflow_has_active_run(config: &JsonValue) -> bool {
    config
        .get("runs")
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .any(|run| {
            matches!(
                run.get("status").and_then(JsonValue::as_str),
                Some("queued" | "running" | "waitingForApproval" | "canceling")
            )
        })
}

fn matching_active_node(
    config: &JsonValue,
    thread_id: &str,
    turn_id: &str,
) -> Option<(String, String)> {
    config
        .get("runs")
        .and_then(JsonValue::as_array)?
        .iter()
        .filter(|run| {
            matches!(
                run.get("status").and_then(JsonValue::as_str),
                Some("queued" | "running")
            )
        })
        .find_map(|run| {
            let run_id = run.get("executionId")?.as_str()?;
            run.get("executedNodes")?
                .as_array()?
                .iter()
                .find(|node| {
                    node.get("threadId").and_then(JsonValue::as_str) == Some(thread_id)
                        && node.get("turnId").and_then(JsonValue::as_str) == Some(turn_id)
                        && matches!(
                            node.get("status").and_then(JsonValue::as_str),
                            Some("queued" | "running")
                        )
                })
                .and_then(|node| node.get("nodeId").and_then(JsonValue::as_str))
                .map(|node_id| (run_id.to_string(), node_id.to_string()))
        })
}

async fn mutate_workflow_run_node(
    cwd: &str,
    file_path: &str,
    run_id: &str,
    node_id: &str,
    mutate: impl FnOnce(
        &mut JsonValue,
        &mut serde_json::Map<String, JsonValue>,
        &mut serde_json::Map<String, JsonValue>,
    ) -> Result<(), JSONRPCErrorError>,
) -> Result<JsonValue, JSONRPCErrorError> {
    let record = super::read_record(
        DomainKind::Workflow,
        &super::validate_record_file_path(cwd, DomainKind::Workflow, file_path)?,
    )
    .await?
    .ok_or_else(|| invalid_params("Workflow config no longer exists"))?;
    let mut config = record.config;
    let (run_index, mut run) = config
        .get("runs")
        .and_then(JsonValue::as_array)
        .and_then(|runs| {
            runs.iter().enumerate().find_map(|(index, run)| {
                (run.get("executionId").and_then(JsonValue::as_str) == Some(run_id))
                    .then(|| (index, run.clone()))
            })
        })
        .ok_or_else(|| invalid_params("Workflow run no longer exists"))?;
    let run_object = run
        .as_object_mut()
        .ok_or_else(|| invalid_params("Workflow run must be an object"))?;
    let (node_index, mut node) = run_object
        .get("executedNodes")
        .and_then(JsonValue::as_array)
        .and_then(|nodes| {
            nodes.iter().enumerate().find_map(|(index, node)| {
                (node.get("nodeId").and_then(JsonValue::as_str) == Some(node_id))
                    .then(|| (index, node.clone()))
            })
        })
        .ok_or_else(|| invalid_params("Workflow run node no longer exists"))?;
    let node_object = node
        .as_object_mut()
        .ok_or_else(|| invalid_params("Workflow run node must be an object"))?;
    mutate(&mut config, run_object, node_object)?;
    run_object
        .get_mut("executedNodes")
        .and_then(JsonValue::as_array_mut)
        .ok_or_else(|| invalid_params("Workflow run nodes must be an array"))?[node_index] = node;
    config
        .get_mut("runs")
        .and_then(JsonValue::as_array_mut)
        .ok_or_else(|| invalid_params("Workflow runs must be an array"))?[run_index] = run;
    update_record(DomainKind::Workflow, cwd, file_path, config.clone()).await?;
    Ok(config)
}

fn workflow_run_response(
    config: &JsonValue,
    run_id: &str,
) -> Result<WorkflowRunResponse, JSONRPCErrorError> {
    let workflow_id = string_field(config, "workflowId")?;
    let run = config
        .get("runs")
        .and_then(JsonValue::as_array)
        .and_then(|runs| {
            runs.iter()
                .find(|run| run.get("executionId").and_then(JsonValue::as_str) == Some(run_id))
        })
        .ok_or_else(|| invalid_params("Workflow run no longer exists"))?;
    let executed_nodes = run
        .get("executedNodes")
        .and_then(JsonValue::as_array)
        .ok_or_else(|| invalid_params("Workflow run nodes must be an array"))?
        .iter()
        .map(|node| {
            Ok(WorkflowNodeExecution {
                node_id: string_field(node, "nodeId")?,
                node_type: node
                    .get("type")
                    .and_then(JsonValue::as_str)
                    .unwrap_or("agent")
                    .to_string(),
                title: string_field(node, "title")?,
                agent_id: node
                    .get("agentId")
                    .and_then(JsonValue::as_str)
                    .map(str::to_string),
                status: string_field(node, "status")?,
                output: node
                    .get("output")
                    .and_then(JsonValue::as_str)
                    .unwrap_or_default()
                    .to_string(),
                error: node
                    .get("error")
                    .and_then(JsonValue::as_str)
                    .map(str::to_string),
            })
        })
        .collect::<Result<Vec<_>, JSONRPCErrorError>>()?;
    Ok(WorkflowRunResponse {
        execution_id: run_id.to_string(),
        workflow_id,
        status: string_field(run, "status")?,
        output: run
            .get("output")
            .and_then(JsonValue::as_str)
            .unwrap_or_default()
            .to_string(),
        executed_nodes,
        error: run
            .get("error")
            .and_then(JsonValue::as_str)
            .map(str::to_string),
    })
}

fn required_string(
    object: &serde_json::Map<String, JsonValue>,
    field: &str,
) -> Result<String, JSONRPCErrorError> {
    object
        .get(field)
        .and_then(JsonValue::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .ok_or_else(|| invalid_params(format!("Workflow run {field} is missing")))
}

fn set_string(object: &mut serde_json::Map<String, JsonValue>, field: &str, value: &str) {
    object.insert(field.to_string(), JsonValue::String(value.to_string()));
}

fn turn_status_is_terminal(status: &TurnStatus) -> bool {
    matches!(
        status,
        TurnStatus::Completed | TurnStatus::Interrupted | TurnStatus::Failed
    )
}

fn last_agent_message(turn: &Turn) -> Option<&str> {
    turn.items.iter().rev().find_map(|item| match item {
        ThreadItem::AgentMessage { text, .. } if !text.trim().is_empty() => Some(text.as_str()),
        _ => None,
    })
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
#[path = "crewon_domain_workflow_tests.rs"]
mod tests;
