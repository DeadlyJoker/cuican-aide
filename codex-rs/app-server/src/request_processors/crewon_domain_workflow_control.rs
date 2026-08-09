use crewon_app_server_protocol::TurnInterruptParams;
use crewon_app_server_protocol::WorkflowGateDecision;
use crewon_app_server_protocol::WorkflowGateResolveParams;
use crewon_app_server_protocol::WorkflowGateResolveResponse;
use crewon_app_server_protocol::WorkflowRunCancelParams;
use crewon_app_server_protocol::WorkflowRunCancelResponse;

use super::*;

#[derive(Clone, Debug)]
pub(crate) struct PreparedWorkflowGateResolution {
    pub(crate) cwd: String,
    pub(crate) file_path: String,
    pub(crate) update: WorkflowRunUpdate,
    pub(crate) next: Option<PreparedWorkflowNodeDispatch>,
    pub(crate) decision: WorkflowGateDecision,
}

#[derive(Clone, Debug)]
pub(crate) struct PreparedWorkflowRunCancel {
    pub(crate) cwd: String,
    pub(crate) file_path: String,
    pub(crate) run_id: String,
    pub(crate) node_id: String,
    pub(crate) target: Option<TurnInterruptParams>,
}

pub(super) struct WorkflowNodeAdvance<'a> {
    pub(super) config: &'a JsonValue,
    pub(super) run: &'a mut serde_json::Map<String, JsonValue>,
    pub(super) current_node_id: &'a str,
    pub(super) output: &'a str,
    pub(super) cwd: &'a str,
    pub(super) file_path: &'a str,
    pub(super) run_id: &'a str,
    pub(super) description: &'a str,
}

impl CrewonDomainRequestProcessor {
    pub(crate) async fn workflow_gate_resolve(
        &self,
        params: WorkflowGateResolveParams,
    ) -> Result<PreparedWorkflowGateResolution, JSONRPCErrorError> {
        let workflow_id = validate_text(&params.workflow_id, 128, "workflowId")?;
        let run_id = validate_text(&params.execution_id, 160, "executionId")?;
        let node_id = validate_text(&params.node_id, 128, "nodeId")?;
        let comment = optional_comment(params.comment)?;
        let record = read_workflow(&params.cwd, &workflow_id)
            .await?
            .ok_or_else(|| invalid_params("Workflow does not exist in the current workspace"))?;
        let configured = parse_nodes(&record.config)?
            .into_iter()
            .find(|node| node.node_id == node_id)
            .ok_or_else(|| invalid_params("Workflow gate node does not exist"))?;
        if configured.node_type != ConfiguredWorkflowNodeType::HumanGate {
            return Err(invalid_params("Workflow node is not a human gate"));
        }
        let description = record
            .config
            .get("description")
            .and_then(JsonValue::as_str)
            .unwrap_or_default()
            .to_string();
        let mut next = None;
        let decision = params.decision;
        let config = mutate_workflow_run_node(
            &params.cwd,
            &record.file_path,
            &run_id,
            &node_id,
            |config, run, node| {
                if run.get("status").and_then(JsonValue::as_str) != Some("waitingForApproval")
                    || node.get("status").and_then(JsonValue::as_str) != Some("waitingForApproval")
                {
                    return Err(invalid_params(
                        "Workflow gate is not waiting for a decision",
                    ));
                }
                let now = Utc::now().timestamp();
                let input = node
                    .get("input")
                    .and_then(JsonValue::as_str)
                    .unwrap_or_default()
                    .to_string();
                let output = gate_output(&input, &comment, decision);
                set_string(node, "output", &output);
                node.insert("error".to_string(), JsonValue::Null);
                node.insert("comment".to_string(), optional_json_string(&comment));
                node.insert("completedAt".to_string(), json!(now));
                node.insert("resolvedAt".to_string(), json!(now));
                match decision {
                    WorkflowGateDecision::Approve => {
                        set_string(node, "status", "completed");
                        set_string(node, "decision", "approved");
                        next = advance_completed_node(WorkflowNodeAdvance {
                            config,
                            run,
                            current_node_id: &node_id,
                            output: &output,
                            cwd: &params.cwd,
                            file_path: &record.file_path,
                            run_id: &run_id,
                            description: &description,
                        })?;
                    }
                    WorkflowGateDecision::Reject => {
                        set_string(node, "status", "rejected");
                        set_string(node, "decision", "rejected");
                        set_string(run, "status", "rejected");
                        set_string(run, "output", &output);
                        run.insert("error".to_string(), JsonValue::Null);
                        run.insert("updatedAt".to_string(), json!(now));
                    }
                }
                let config_object = config
                    .as_object_mut()
                    .ok_or_else(|| invalid_params("Workflow config must be an object"))?;
                set_string(config_object, "status", config_status_for_run(run));
                config_object.insert("updatedAt".to_string(), json!(now));
                Ok(())
            },
        )
        .await?;
        let update = WorkflowRunUpdate {
            response: workflow_run_response(&config, &run_id)?,
            config,
        };
        Ok(PreparedWorkflowGateResolution {
            cwd: params.cwd,
            file_path: record.file_path,
            update,
            next,
            decision,
        })
    }

    pub(crate) async fn workflow_run_cancel_prepare(
        &self,
        params: WorkflowRunCancelParams,
    ) -> Result<PreparedWorkflowRunCancel, JSONRPCErrorError> {
        let workflow_id = validate_text(&params.workflow_id, 128, "workflowId")?;
        let run_id = validate_text(&params.execution_id, 160, "executionId")?;
        let record = read_workflow(&params.cwd, &workflow_id)
            .await?
            .ok_or_else(|| invalid_params("Workflow does not exist in the current workspace"))?;
        let run = find_run(&record.config, &run_id)?;
        if !matches!(
            run.get("status").and_then(JsonValue::as_str),
            Some("queued" | "running" | "waitingForApproval" | "canceling")
        ) {
            return Err(invalid_params("Workflow run is already terminal"));
        }
        let node = run
            .get("executedNodes")
            .and_then(JsonValue::as_array)
            .and_then(|nodes| {
                nodes.iter().find(|node| {
                    matches!(
                        node.get("status").and_then(JsonValue::as_str),
                        Some("queued" | "running" | "waitingForApproval" | "canceling")
                    )
                })
            })
            .ok_or_else(|| invalid_params("Workflow run has no active node"))?;
        let node_id = string_field(node, "nodeId")?;
        let target = if node.get("status").and_then(JsonValue::as_str) == Some("running") {
            Some(TurnInterruptParams {
                thread_id: string_field(node, "threadId")?,
                turn_id: string_field(node, "turnId")?,
            })
        } else {
            None
        };
        Ok(PreparedWorkflowRunCancel {
            cwd: params.cwd,
            file_path: record.file_path,
            run_id,
            node_id,
            target,
        })
    }

    pub(crate) async fn workflow_run_cancel_commit(
        &self,
        prepared: &PreparedWorkflowRunCancel,
    ) -> Result<WorkflowRunCancelResponse, JSONRPCErrorError> {
        let config = mutate_workflow_run_node(
            &prepared.cwd,
            &prepared.file_path,
            &prepared.run_id,
            &prepared.node_id,
            |config, run, node| {
                let now = Utc::now().timestamp();
                set_string(node, "status", "canceled");
                node.insert("error".to_string(), JsonValue::Null);
                set_string(node, "cancelReason", "userRequested");
                node.insert("canceledAt".to_string(), json!(now));
                node.insert("completedAt".to_string(), json!(now));
                set_string(run, "status", "canceled");
                run.insert("error".to_string(), JsonValue::Null);
                run.insert("updatedAt".to_string(), json!(now));
                let config_object = config
                    .as_object_mut()
                    .ok_or_else(|| invalid_params("Workflow config must be an object"))?;
                set_string(config_object, "status", "ready");
                config_object.insert("updatedAt".to_string(), json!(now));
                Ok(())
            },
        )
        .await?;
        let run = workflow_run_response(&config, &prepared.run_id)?;
        Ok(WorkflowRunCancelResponse {
            file_path: prepared.file_path.clone(),
            config,
            execution_id: run.execution_id,
            workflow_id: run.workflow_id,
            status: run.status,
            output: run.output,
            executed_nodes: run.executed_nodes,
            error: run.error,
        })
    }
}

pub(super) fn advance_completed_node(
    advance: WorkflowNodeAdvance<'_>,
) -> Result<Option<PreparedWorkflowNodeDispatch>, JSONRPCErrorError> {
    let WorkflowNodeAdvance {
        config,
        run,
        current_node_id,
        output,
        cwd,
        file_path,
        run_id,
        description,
    } = advance;
    let configured_nodes = parse_nodes(config)?;
    let executed_nodes = run
        .get_mut("executedNodes")
        .and_then(JsonValue::as_array_mut)
        .ok_or_else(|| invalid_params("Workflow run nodes must be an array"))?;
    let current_index = executed_nodes
        .iter()
        .position(|candidate| {
            candidate.get("nodeId").and_then(JsonValue::as_str) == Some(current_node_id)
        })
        .ok_or_else(|| invalid_params("Workflow run node is missing"))?;
    let Some(next_node) = executed_nodes.get_mut(current_index + 1) else {
        let now = Utc::now().timestamp();
        set_string(run, "status", "completed");
        set_string(run, "output", output);
        run.insert("error".to_string(), JsonValue::Null);
        run.insert("updatedAt".to_string(), json!(now));
        return Ok(None);
    };
    let next_object = next_node
        .as_object_mut()
        .ok_or_else(|| invalid_params("Workflow run node must be an object"))?;
    let next_node_id = required_string(next_object, "nodeId")?;
    let configured = configured_nodes
        .into_iter()
        .find(|candidate| candidate.node_id == next_node_id)
        .ok_or_else(|| invalid_params("Workflow configured node is missing"))?;
    let now = Utc::now().timestamp();
    set_string(next_object, "input", output);
    next_object.insert("startedAt".to_string(), json!(now));
    match &configured.node_type {
        ConfiguredWorkflowNodeType::Agent { agent_id, .. } => {
            let thread_id = required_string(next_object, "threadId")?;
            set_string(next_object, "status", "queued");
            set_string(run, "status", "running");
            run.insert("updatedAt".to_string(), json!(now));
            Ok(Some(PreparedWorkflowNodeDispatch {
                cwd: cwd.to_string(),
                file_path: file_path.to_string(),
                run_id: run_id.to_string(),
                node_id: next_node_id,
                agent_id: agent_id.clone(),
                thread_id,
                prompt: node_message(description, &configured, output),
            }))
        }
        ConfiguredWorkflowNodeType::HumanGate => {
            set_string(next_object, "status", "waitingForApproval");
            set_string(run, "status", "waitingForApproval");
            run.insert("updatedAt".to_string(), json!(now));
            Ok(None)
        }
    }
}

pub(super) fn config_status_for_run(run: &serde_json::Map<String, JsonValue>) -> &'static str {
    match run.get("status").and_then(JsonValue::as_str) {
        Some("queued" | "running") => "running",
        Some("waitingForApproval") => "waitingForApproval",
        Some("canceling") => "canceling",
        _ => "ready",
    }
}

fn find_run<'a>(config: &'a JsonValue, run_id: &str) -> Result<&'a JsonValue, JSONRPCErrorError> {
    config
        .get("runs")
        .and_then(JsonValue::as_array)
        .and_then(|runs| {
            runs.iter()
                .find(|run| run.get("executionId").and_then(JsonValue::as_str) == Some(run_id))
        })
        .ok_or_else(|| invalid_params("Workflow run does not exist"))
}

fn optional_comment(value: Option<String>) -> Result<Option<String>, JSONRPCErrorError> {
    value
        .map(|value| {
            let value = value.trim();
            if value.chars().count() > MAX_INSTRUCTION_CHARS
                || value.chars().any(|character| {
                    character.is_control() && !matches!(character, '\n' | '\r' | '\t')
                })
            {
                return Err(invalid_params("Workflow gate comment is invalid"));
            }
            Ok((!value.is_empty()).then(|| value.to_string()))
        })
        .transpose()
        .map(Option::flatten)
}

fn optional_json_string(value: &Option<String>) -> JsonValue {
    value
        .as_ref()
        .map_or(JsonValue::Null, |value| JsonValue::String(value.clone()))
}

fn gate_output(input: &str, comment: &Option<String>, decision: WorkflowGateDecision) -> String {
    let decision = match decision {
        WorkflowGateDecision::Approve => "已批准",
        WorkflowGateDecision::Reject => "已驳回",
    };
    let suffix = comment.as_ref().map_or_else(
        || format!("人工 Gate：{decision}"),
        |comment| format!("人工 Gate：{decision}\n审批说明：{comment}"),
    );
    let output = if input.trim().is_empty() {
        suffix
    } else {
        format!("{input}\n\n{suffix}")
    };
    truncate_chars(&output, MAX_OUTPUT_CHARS)
}

impl From<PreparedWorkflowGateResolution> for WorkflowGateResolveResponse {
    fn from(prepared: PreparedWorkflowGateResolution) -> Self {
        let run = prepared.update.response;
        Self {
            file_path: prepared.file_path,
            config: prepared.update.config,
            execution_id: run.execution_id,
            workflow_id: run.workflow_id,
            status: run.status,
            output: run.output,
            executed_nodes: run.executed_nodes,
            error: run.error,
        }
    }
}
