use super::*;
use pretty_assertions::assert_eq;
use tempfile::TempDir;

fn authority(owner_subject: &str) -> ExpertTeamAuthority {
    ExpertTeamAuthority::new(
        owner_subject.to_string(),
        Some("tenant-1".to_string()),
        Some("space-1".to_string()),
    )
    .expect("server-derived Experts authority")
}

fn workspace(workspace_key: &str) -> WorkspaceRef {
    WorkspaceRef {
        workspace_key: workspace_key.to_string(),
        binding_id: "binding-1".to_string(),
        scope: WorkspaceScope::Conversation,
        scope_id: "thread-1".to_string(),
        node_id: "node-1".to_string(),
        environment_id: "environment-1".to_string(),
    }
}

fn role(name: &str) -> ExpertRole {
    ExpertRole {
        name: name.to_string(),
        role: format!("{name} role"),
        agent_type: if name == "Leader" {
            "worker".to_string()
        } else {
            "explorer".to_string()
        },
        instructions: Some(format!("{name} instructions")),
    }
}

fn create_params() -> ExpertTeamCreateParams {
    ExpertTeamCreateParams {
        workspace_key: "workspace-1".to_string(),
        title: " Delivery review ".to_string(),
        goal: " Review the release from independent perspectives. ".to_string(),
        leader: role("Leader"),
        experts: vec![role("Security"), role("Reliability")],
    }
}

#[tokio::test]
async fn creates_lists_and_reads_an_owned_conversation_experts_record() {
    let root = TempDir::new().expect("workspace root");
    let processor = ExpertsRequestProcessor::new();
    let authority = authority("owner-1");
    let workspace = workspace("workspace-1");

    let created = processor
        .create(root.path(), &authority, &workspace, create_params())
        .await
        .expect("create Experts definition");
    assert_eq!(created.record.config.title, "Delivery review");
    assert_eq!(created.record.config.owner_subject, "owner-1");
    assert_eq!(created.record.config.workspace_key, "workspace-1");
    assert_eq!(created.record.config.experts.len(), 2);
    assert!(created.record.file_path.contains("/.crewon/experts/"));

    let listed = processor
        .list(
            root.path(),
            &authority,
            &workspace,
            ExpertTeamListParams {
                workspace_key: "workspace-1".to_string(),
                cursor: None,
                limit: None,
            },
        )
        .await
        .expect("list Experts definitions");
    assert_eq!(listed.data, vec![created.record.clone()]);
    assert_eq!(listed.next_cursor, None);

    let read = processor
        .read(
            root.path(),
            &authority,
            &workspace,
            ExpertTeamReadParams {
                workspace_key: "workspace-1".to_string(),
                experts_id: created.record.config.experts_id.clone(),
            },
        )
        .await
        .expect("read Experts definition");
    assert_eq!(read.record, Some(created.record));
}

#[tokio::test]
async fn filters_records_by_owner_and_workspace_authority() {
    let root = TempDir::new().expect("workspace root");
    let processor = ExpertsRequestProcessor::new();
    let owner = authority("owner-1");
    let owner_workspace = workspace("workspace-1");
    let created = processor
        .create(root.path(), &owner, &owner_workspace, create_params())
        .await
        .expect("create Experts definition");

    let other_owner = authority("owner-2");
    let hidden = processor
        .read(
            root.path(),
            &other_owner,
            &owner_workspace,
            ExpertTeamReadParams {
                workspace_key: "workspace-1".to_string(),
                experts_id: created.record.config.experts_id.clone(),
            },
        )
        .await
        .expect("read is authorization-filtered");
    assert_eq!(hidden.record, None);

    let other_workspace = workspace("workspace-2");
    let listed = processor
        .list(
            root.path(),
            &owner,
            &other_workspace,
            ExpertTeamListParams {
                workspace_key: "workspace-2".to_string(),
                cursor: None,
                limit: None,
            },
        )
        .await
        .expect("list is workspace-filtered");
    assert_eq!(listed.data, Vec::<ExpertTeamRecord>::new());
}

#[tokio::test]
async fn rejects_invalid_role_sets_and_non_conversation_scope() {
    let root = TempDir::new().expect("workspace root");
    let processor = ExpertsRequestProcessor::new();
    let authority = authority("owner-1");
    let workspace = workspace("workspace-1");
    let mut mismatched_workspace = create_params();
    mismatched_workspace.workspace_key = "workspace-2".to_string();
    let error = processor
        .create(root.path(), &authority, &workspace, mismatched_workspace)
        .await
        .expect_err("client workspace key must match server resolution");
    assert_eq!(
        error.message,
        "workspaceKey does not match the server-resolved workspace"
    );

    let mut params = create_params();
    params.experts.pop();
    let error = processor
        .create(root.path(), &authority, &workspace, params)
        .await
        .expect_err("one expert is insufficient");
    assert_eq!(error.message, "experts must contain between 2 and 8 roles");

    let mut duplicate = create_params();
    duplicate.experts[0].name = "leader".to_string();
    let error = processor
        .create(root.path(), &authority, &workspace, duplicate)
        .await
        .expect_err("duplicate names are rejected");
    assert_eq!(error.message, "Expert role names must be unique");

    let mut invalid_agent_type = create_params();
    invalid_agent_type.experts[0].agent_type = "custom".to_string();
    let error = processor
        .create(root.path(), &authority, &workspace, invalid_agent_type)
        .await
        .expect_err("unavailable core roles are rejected");
    assert_eq!(
        error.message,
        "experts[0].agentType must be explorer or worker"
    );

    let mut office_workspace = workspace;
    office_workspace.scope = WorkspaceScope::Office;
    let error = processor
        .create(root.path(), &authority, &office_workspace, create_params())
        .await
        .expect_err("Office scope is rejected");
    assert_eq!(
        error.message,
        "Experts require a Conversation workspace binding"
    );
}

#[test]
fn rejects_non_canonical_or_incomplete_server_authority() {
    let error = ExpertTeamAuthority::new(
        " owner-1 ".to_string(),
        Some("tenant-1".to_string()),
        Some("space-1".to_string()),
    )
    .expect_err("server authority must already be canonical");
    assert_eq!(
        error.message,
        "ownerSubject is not a canonical server-derived value"
    );

    let error = ExpertTeamAuthority::new("owner-1".to_string(), None, Some("space-1".to_string()))
        .expect_err("space authority requires tenant authority");
    assert_eq!(
        error.message,
        "Experts authority cannot contain a space without a tenant"
    );
}

#[tokio::test]
async fn rejects_outside_paths_and_symlinked_storage() {
    let root = TempDir::new().expect("workspace root");
    let outside = TempDir::new().expect("outside directory");
    let outside_file = outside.path().join("experts-outside.json");
    fs::write(&outside_file, b"{}")
        .await
        .expect("write outside fixture");
    let error =
        read_expert_team_record_by_file_path(root.path(), outside_file.to_string_lossy().as_ref())
            .await
            .expect_err("outside path is rejected");
    assert_eq!(
        error.message,
        "Experts record path is outside the workspace Experts directory"
    );

    #[cfg(unix)]
    {
        let symlink_root = TempDir::new().expect("symlink workspace root");
        std::os::unix::fs::symlink(outside.path(), symlink_root.path().join(".crewon"))
            .expect("create storage symlink");
        let error = ExpertsRequestProcessor::new()
            .create(
                symlink_root.path(),
                &authority("owner-1"),
                &workspace("workspace-1"),
                create_params(),
            )
            .await
            .expect_err("symlinked storage is rejected");
        assert_eq!(
            error.message,
            "Experts storage must use regular workspace directories"
        );
    }
}

#[tokio::test]
async fn persisted_record_is_bounded_and_does_not_store_local_or_office_authority() {
    let root = TempDir::new().expect("workspace root");
    let processor = ExpertsRequestProcessor::new();
    let authority = authority("owner-1");
    let workspace = workspace("workspace-1");
    let created = processor
        .create(root.path(), &authority, &workspace, create_params())
        .await
        .expect("create Experts definition");
    let contents = fs::read_to_string(&created.record.file_path)
        .await
        .expect("read persisted definition");
    assert!(contents.len() <= MAX_RECORD_BYTES);
    assert!(!contents.contains(root.path().to_string_lossy().as_ref()));
    assert!(!contents.contains("officeRecord"));
    assert!(contents.contains("\"workspaceKey\": \"workspace-1\""));
    assert!(contents.contains("\"ownerSubject\": \"owner-1\""));
}
