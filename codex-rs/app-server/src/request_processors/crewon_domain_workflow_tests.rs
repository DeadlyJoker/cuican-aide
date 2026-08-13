use crewon_app_server_protocol::WorkflowCreateParams;
use crewon_app_server_protocol::WorkflowNodeDefinition;
use pretty_assertions::assert_eq;
use serde_json::json;
use tempfile::TempDir;

use super::CrewonDomainRequestProcessor;
use super::DomainKind;
use super::PreparedWorkflowNodeDispatch;
use super::create_record;
use super::recovery::WorkflowActiveTurnRef;
use super::recovery::WorkflowRecoveryState;
use super::validate_create;

#[test]
fn workflow_create_requires_bounded_nodes() {
    let valid = WorkflowCreateParams {
        cwd: "/workspace".to_string(),
        name: "交付协作流".to_string(),
        description: "顺序完成审阅与交付".to_string(),
        lead: "CrewON".to_string(),
        nodes: vec![WorkflowNodeDefinition::Agent {
            title: "需求审阅".to_string(),
            agent_id: "agent-review".to_string(),
            agent_name: "合同审核智能体".to_string(),
            instruction: "输出风险列表".to_string(),
        }],
    };
    assert!(validate_create(&valid).is_ok());

    let mut empty = valid;
    empty.nodes.clear();
    assert!(validate_create(&empty).is_err());
}

#[tokio::test]
async fn workflow_recovery_classifies_queued_and_running_nodes() {
    let workspace = TempDir::new().expect("workspace");
    let cwd = workspace.path().to_string_lossy().into_owned();
    let config = json!({
        "workflowId": "workflow-recovery",
        "name": "Recovery",
        "description": "Ship",
        "nodes": [
            {
                "nodeId": "node-1",
                "title": "Review",
                "agentId": "agent-review",
                "agentName": "Reviewer",
                "instruction": "Check"
            },
            {
                "nodeId": "node-2",
                "title": "Deliver",
                "agentId": "agent-delivery",
                "agentName": "Deliverer",
                "instruction": "Finish"
            },
            {
                "nodeId": "node-3",
                "type": "humanGate",
                "title": "Approve",
                "instruction": "Confirm"
            }
        ],
        "runs": [
            {
                "executionId": "run-queued",
                "status": "queued",
                "executedNodes": [{
                    "nodeId": "node-1",
                    "status": "queued",
                    "threadId": "thread-queued",
                    "turnId": null,
                    "input": "input"
                }]
            },
            {
                "executionId": "run-active",
                "status": "running",
                "executedNodes": [{
                    "nodeId": "node-2",
                    "status": "running",
                    "threadId": "thread-active",
                    "turnId": "turn-active",
                    "input": "reviewed"
                }]
            },
            {
                "executionId": "run-gate",
                "status": "waitingForApproval",
                "executedNodes": [{
                    "nodeId": "node-3",
                    "status": "waitingForApproval",
                    "threadId": null,
                    "turnId": null,
                    "input": "deliverable"
                }]
            }
        ]
    });
    let file_path = create_record(DomainKind::Workflow, &cwd, config)
        .await
        .expect("workflow record");
    let recovery = CrewonDomainRequestProcessor::new()
        .workflow_recovery_state(&cwd)
        .await
        .expect("recovery state");

    assert_eq!(
        recovery,
        WorkflowRecoveryState {
            queued: vec![PreparedWorkflowNodeDispatch {
                cwd,
                file_path,
                run_id: "run-queued".to_string(),
                node_id: "node-1".to_string(),
                agent_id: "agent-review".to_string(),
                thread_id: "thread-queued".to_string(),
                prompt: "CrewON 协作流目标：Ship\n当前节点：Review\n节点要求：Check\n\n上一步输入：\ninput"
                    .to_string(),
            }],
            active_turns: vec![WorkflowActiveTurnRef {
                thread_id: "thread-active".to_string(),
                turn_id: "turn-active".to_string(),
            }],
        }
    );
}
