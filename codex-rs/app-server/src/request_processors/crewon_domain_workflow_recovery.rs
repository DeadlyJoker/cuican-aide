use super::*;

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct WorkflowActiveTurnRef {
    pub(crate) thread_id: String,
    pub(crate) turn_id: String,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct WorkflowRecoveryState {
    pub(crate) queued: Vec<PreparedWorkflowNodeDispatch>,
    pub(crate) active_turns: Vec<WorkflowActiveTurnRef>,
}

impl CrewonDomainRequestProcessor {
    pub(crate) async fn workflow_agent_ids(
        &self,
        params: &WorkflowRunParams,
    ) -> Result<Vec<String>, JSONRPCErrorError> {
        validate_text(&params.input, MAX_INPUT_CHARS, "input")?;
        let record = read_workflow(&params.cwd, &params.workflow_id)
            .await?
            .ok_or_else(|| invalid_params("Workflow does not exist in the current workspace"))?;
        let nodes = parse_nodes(&record.config)?;
        let mut agent_ids = Vec::new();
        for node in nodes {
            let ConfiguredWorkflowNodeType::Agent { agent_id, .. } = node.node_type else {
                continue;
            };
            if !agent_ids.contains(&agent_id) {
                agent_ids.push(agent_id);
            }
        }
        Ok(agent_ids)
    }

    pub(crate) async fn workflow_recovery_state(
        &self,
        cwd: &str,
    ) -> Result<WorkflowRecoveryState, JSONRPCErrorError> {
        let (records, _) = list_records(
            DomainKind::Workflow,
            cwd,
            /*cursor*/ None,
            /*limit*/ Some(MAX_LIST_LIMIT as u32),
        )
        .await?;
        let mut recovery = WorkflowRecoveryState::default();
        for record in records {
            let description = record
                .config
                .get("description")
                .and_then(JsonValue::as_str)
                .unwrap_or_default();
            let configured_nodes = parse_nodes(&record.config)?;
            let Some(runs) = record.config.get("runs").and_then(JsonValue::as_array) else {
                continue;
            };
            for run in runs {
                if !matches!(
                    run.get("status").and_then(JsonValue::as_str),
                    Some("queued" | "running")
                ) {
                    continue;
                }
                let run_id = string_field(run, "executionId")?;
                let Some(node) = run
                    .get("executedNodes")
                    .and_then(JsonValue::as_array)
                    .and_then(|nodes| {
                        nodes.iter().find(|node| {
                            matches!(
                                node.get("status").and_then(JsonValue::as_str),
                                Some("queued" | "running")
                            )
                        })
                    })
                else {
                    continue;
                };
                let node_id = string_field(node, "nodeId")?;
                let thread_id = string_field(node, "threadId")?;
                match node.get("status").and_then(JsonValue::as_str) {
                    Some("running") => {
                        let turn_id = string_field(node, "turnId")?;
                        recovery
                            .active_turns
                            .push(WorkflowActiveTurnRef { thread_id, turn_id });
                    }
                    Some("queued") => {
                        let configured = configured_nodes
                            .iter()
                            .find(|configured| configured.node_id == node_id)
                            .ok_or_else(|| invalid_params("Workflow configured node is missing"))?;
                        let ConfiguredWorkflowNodeType::Agent { agent_id, .. } =
                            &configured.node_type
                        else {
                            return Err(invalid_params(
                                "Queued Workflow node must be an Agent node",
                            ));
                        };
                        let input = node
                            .get("input")
                            .and_then(JsonValue::as_str)
                            .unwrap_or_default();
                        recovery.queued.push(PreparedWorkflowNodeDispatch {
                            cwd: cwd.to_string(),
                            file_path: record.file_path.clone(),
                            run_id,
                            node_id,
                            agent_id: agent_id.clone(),
                            thread_id,
                            prompt: node_message(description, configured, input),
                        });
                    }
                    Some(_) | None => {}
                }
            }
        }
        Ok(recovery)
    }
}
