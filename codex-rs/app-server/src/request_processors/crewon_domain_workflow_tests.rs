use crewon_app_server_protocol::WorkflowCreateParams;
use crewon_app_server_protocol::WorkflowNodeDefinition;
use pretty_assertions::assert_eq;
use serde_json::Value as JsonValue;
use serde_json::json;
use tempfile::TempDir;

use super::CrewonDomainRequestProcessor;
use super::DomainKind;
use super::PreparedWorkflowNodeDispatch;
use super::create_record;
use super::recovery::WorkflowActiveTurnRef;
use super::recovery::WorkflowRecoveryState;
use super::require_legacy_workflow_runtime;
use super::validate_create;

const WORKFLOW_COMPATIBILITY_FIXTURE: &str = include_str!(
    "../../../../packages/test-contracts/fixtures/workflow-rust-compatibility.reference.json"
);

#[test]
fn shared_fixture_keeps_typescript_canonical_workflows_out_of_rust_runtime() {
    let fixture: JsonValue =
        serde_json::from_str(WORKFLOW_COMPATIBILITY_FIXTURE).expect("compatibility fixture");
    assert_eq!(
        require_legacy_workflow_runtime(&fixture["rustLegacyAuthority"]),
        Ok(())
    );
    assert_eq!(
        require_legacy_workflow_runtime(&fixture["untaggedImportedLegacyAuthority"]),
        Ok(())
    );
    let error = require_legacy_workflow_runtime(&fixture["typescriptCanonicalSource"])
        .expect_err("TypeScript canonical authority must fail closed");
    assert_eq!(
        error.message,
        "Canonical WorkflowVersion is owned by the TypeScript DAG runtime; Rust only imports and executes legacy serial Workflow records"
    );
}

#[tokio::test]
async fn workflow_run_admission_accepts_untagged_import_and_rejects_canonical_source() {
    let workspace = TempDir::new().expect("workspace");
    let cwd = workspace.path().to_string_lossy().into_owned();
    let legacy = json!({
        "workflowId": "imported-legacy-workflow",
        "name": "Imported",
        "description": "Legacy import",
        "nodes": [{
            "nodeId": "node-1",
            "type": "humanGate",
            "title": "Approve",
            "instruction": "Confirm"
        }],
        "runs": []
    });
    create_record(DomainKind::Workflow, &cwd, legacy)
        .await
        .expect("legacy workflow record");
    let processor = CrewonDomainRequestProcessor::new();
    let prepared = processor
        .workflow_run_prepare(
            crewon_app_server_protocol::WorkflowRunParams {
                cwd: cwd.clone(),
                workflow_id: "imported-legacy-workflow".to_string(),
                input: "input".to_string(),
            },
            &std::collections::HashMap::new(),
        )
        .await
        .expect("untagged legacy admission");
    assert_eq!(prepared.update.response.status, "waitingForApproval");

    let fixture: JsonValue =
        serde_json::from_str(WORKFLOW_COMPATIBILITY_FIXTURE).expect("compatibility fixture");
    let canonical = fixture["typescriptCanonicalSource"].clone();
    create_record(DomainKind::Workflow, &cwd, canonical)
        .await
        .expect("canonical source record");
    let error = processor
        .workflow_run_prepare(
            crewon_app_server_protocol::WorkflowRunParams {
                cwd,
                workflow_id: "canonical-workflow".to_string(),
                input: "input".to_string(),
            },
            &std::collections::HashMap::new(),
        )
        .await
        .expect_err("canonical source must not enter Rust runtime");
    assert_eq!(
        error.message,
        "Canonical WorkflowVersion is owned by the TypeScript DAG runtime; Rust only imports and executes legacy serial Workflow records"
    );
}

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
