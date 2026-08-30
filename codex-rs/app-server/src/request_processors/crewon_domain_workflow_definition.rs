use super::*;

pub(super) fn validate_create(params: &WorkflowCreateParams) -> Result<(), JSONRPCErrorError> {
    validate_text(&params.name, MAX_NAME_CHARS, "name")?;
    validate_text(&params.description, MAX_DESCRIPTION_CHARS, "description")?;
    validate_text(&params.lead, MAX_NAME_CHARS, "lead")?;
    if params.nodes.is_empty() || params.nodes.len() > MAX_WORKFLOW_NODES {
        return Err(invalid_params(
            "Workflow must contain between 1 and 20 nodes",
        ));
    }
    for node in &params.nodes {
        validate_node(node)?;
    }
    Ok(())
}

fn validate_node(node: &WorkflowNodeDefinition) -> Result<(), JSONRPCErrorError> {
    let (title, instruction) = match node {
        WorkflowNodeDefinition::Agent {
            title,
            agent_id,
            agent_name,
            instruction,
        } => {
            validate_text(agent_name, MAX_NAME_CHARS, "node.agentName")?;
            let agent_id = validate_text(agent_id, 128, "node.agentId")?;
            if !agent_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            {
                return Err(invalid_params(
                    "node.agentId must be a safe resource identifier",
                ));
            }
            (title, instruction)
        }
        WorkflowNodeDefinition::HumanGate { title, instruction } => (title, instruction),
    };
    validate_text(title, MAX_NAME_CHARS, "node.title")?;
    validate_text(instruction, MAX_INSTRUCTION_CHARS, "node.instruction")?;
    Ok(())
}

pub(super) fn workflow_node_config((index, node): (usize, WorkflowNodeDefinition)) -> JsonValue {
    let node_id = format!("node-{}", index + 1);
    match node {
        WorkflowNodeDefinition::Agent {
            title,
            agent_id,
            agent_name,
            instruction,
        } => json!({
            "nodeId": node_id,
            "type": "agent",
            "title": title.trim(),
            "agentId": agent_id.trim(),
            "agentName": agent_name.trim(),
            "instruction": instruction.trim(),
        }),
        WorkflowNodeDefinition::HumanGate { title, instruction } => json!({
            "nodeId": node_id,
            "type": "humanGate",
            "title": title.trim(),
            "instruction": instruction.trim(),
        }),
    }
}

pub(super) fn validate_text(
    value: &str,
    max_chars: usize,
    field: &str,
) -> Result<String, JSONRPCErrorError> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > max_chars
        || value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(invalid_params(format!("Workflow {field} is invalid")));
    }
    Ok(value.to_string())
}

pub(super) fn parse_nodes(
    config: &JsonValue,
) -> Result<Vec<ConfiguredWorkflowNode>, JSONRPCErrorError> {
    let nodes = config
        .get("nodes")
        .and_then(JsonValue::as_array)
        .ok_or_else(|| invalid_params("Workflow nodes are missing"))?;
    nodes
        .iter()
        .map(|node| {
            let node_id = string_field(node, "nodeId")?;
            let title = string_field(node, "title")?;
            let instruction = string_field(node, "instruction")?;
            let definition = match node
                .get("type")
                .and_then(JsonValue::as_str)
                .unwrap_or("agent")
            {
                "agent" => WorkflowNodeDefinition::Agent {
                    title: title.clone(),
                    agent_id: string_field(node, "agentId")?,
                    agent_name: string_field(node, "agentName")?,
                    instruction: instruction.clone(),
                },
                "humanGate" => WorkflowNodeDefinition::HumanGate {
                    title: title.clone(),
                    instruction: instruction.clone(),
                },
                _ => return Err(invalid_params("Workflow node type is invalid")),
            };
            validate_node(&definition)?;
            let node_type = match definition {
                WorkflowNodeDefinition::Agent {
                    agent_id,
                    agent_name,
                    ..
                } => ConfiguredWorkflowNodeType::Agent {
                    agent_id,
                    agent_name,
                },
                WorkflowNodeDefinition::HumanGate { .. } => ConfiguredWorkflowNodeType::HumanGate,
            };
            Ok(ConfiguredWorkflowNode {
                node_id,
                node_type,
                title,
                instruction,
            })
        })
        .collect()
}

pub(super) fn node_type_name(node_type: &ConfiguredWorkflowNodeType) -> &'static str {
    match node_type {
        ConfiguredWorkflowNodeType::Agent { .. } => "agent",
        ConfiguredWorkflowNodeType::HumanGate => "humanGate",
    }
}

pub(super) fn node_message(
    description: &str,
    node: &ConfiguredWorkflowNode,
    input: &str,
) -> String {
    let prefix = format!(
        "CrewON 协作流目标：{description}\n当前节点：{}\n节点要求：{}\n\n上一步输入：\n",
        node.title, node.instruction
    );
    let remaining = MAX_INPUT_CHARS.saturating_sub(prefix.chars().count());
    let input = input.chars().take(remaining).collect::<String>();
    format!("{prefix}{input}")
}
