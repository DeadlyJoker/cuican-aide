use crewon_app_server_protocol::WorkspaceRef;
use crewon_app_server_protocol::WorkspaceScope;
use crewon_resource_federation::BindingId;
use crewon_resource_federation::BindingMode;
use crewon_resource_federation::BindingRequest;
use crewon_resource_federation::Capability;
use crewon_resource_federation::ExecutionLocation;
use crewon_resource_federation::ManifestSchemaVersion;
use crewon_resource_federation::ProviderCapabilities;
use crewon_resource_federation::ProviderId;
use crewon_resource_federation::ProviderProtocolVersion;
use crewon_resource_federation::ProviderRef;
use crewon_resource_federation::ResolvedResourceBinding;
use crewon_resource_federation::ResourceId;
use crewon_resource_federation::ResourceKind;
use crewon_resource_federation::ResourceManifest;
use crewon_resource_federation::ResourceRef;
use crewon_resource_federation::ResourceRevision;
use crewon_resource_federation::WorkspaceKey;
use crewon_resource_federation::resolve_binding;
use crewon_state::ArtifactRetentionKind;
use crewon_state::CloudAgentLegacyImportStart;
use crewon_state::CloudAgentLegacyImportStartOutcome;
use crewon_state::CloudAgentLegacyImportStatus;
use crewon_state::CloudAgentTurnPageQuery;
use crewon_state::CloudAgentTurnSortDirection;
use crewon_state::CloudAgentTurnStatus;
use crewon_state::StateRuntime;
use crewon_state::ThreadExecutionContextBindingRef;
use pretty_assertions::assert_eq;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

use super::CloudAgentLegacySessionImportOutcome;
use super::CloudAgentLegacySessionImportRequest;
use super::CloudAgentLegacySessionImporter;
use super::stable_id;
use crate::platform_control::authenticated_identity_in_space;
use crate::task_control::cloud_agent_legacy_import_artifact::commit_legacy_artifact;
use crate::task_control::cloud_agent_legacy_import_source::read_legacy_session_source;
use crate::task_control::cloud_agent_legacy_import_source::session_key;
use crate::task_control::cloud_agent_turn_coordinator::tests::fixture;

const THREAD_ID: &str = "019f550e-ba52-7490-a248-b0d3a84103c1";
const WORKSPACE_KEY: &str = "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c001";
const BINDING_ID: &str = "resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c301";
const BASE_URL: &str = "https://agent-platform.test";

#[tokio::test]
async fn resumes_after_partial_artifact_commit_with_stable_journal_and_trace() {
    let fixture = fixture().await;
    let binding_record = fixture
        .state
        .get_provider_resource_binding_record(BINDING_ID)
        .await
        .expect("read Agent binding")
        .expect("Agent binding exists");
    let binding = resolved_binding(&binding_record);
    let workspace = workspace();
    write_legacy_session(fixture.home.path()).await;
    let importer = CloudAgentLegacySessionImporter::new(
        fixture.state.clone(),
        fixture.home.path().to_path_buf(),
        Some(BASE_URL),
    );
    let initial_request = request(&fixture.identity, &workspace, &binding, /*now*/ 200);
    let source = read_legacy_session_source(
        importer.history_root.clone(),
        importer.deployment_namespace.clone(),
        /*user_id*/ 42,
        THREAD_ID.to_string(),
        "agent-1".to_string(),
    )
    .await
    .expect("read source for crash fixture");
    let journal_id = stable_id("legacy-journal", source.source_key.as_bytes());
    let start = CloudAgentLegacyImportStart {
        journal_id: journal_id.clone(),
        source_key: source.source_key.clone(),
        source_digest: source.source_digest.clone(),
        source_bytes: source.source_bytes,
        thread_id: THREAD_ID.to_string(),
        execution_binding: ThreadExecutionContextBindingRef {
            binding_id: BINDING_ID.to_string(),
            revision: 1,
        },
        expected_turn_count: 2,
        imported_at: 200,
    };
    assert!(matches!(
        fixture
            .state
            .start_cloud_agent_legacy_import(&start)
            .await
            .expect("start durable journal"),
        CloudAgentLegacyImportStartOutcome::Started(_)
    ));
    let turn_group = stable_id("legacy-turn-group", journal_id.as_bytes());
    commit_legacy_artifact(
        fixture.state.as_ref(),
        &initial_request,
        &source,
        &format!("{turn_group}:0000"),
        /*ordinal*/ 0,
        "prompt",
        &source.rounds[0].prompt,
        /*imported_at*/ 200,
    )
    .await
    .expect("commit one Artifact before simulated crash");

    fixture.state.close().await;
    drop(importer);
    let restarted = StateRuntime::init(
        fixture.home.path().to_path_buf(),
        "test-provider".to_string(),
    )
    .await
    .expect("restart State");
    let retry_identity = authenticated_identity_in_space("trace-after-restart", "space-local-1");
    let restarted_importer = CloudAgentLegacySessionImporter::new(
        restarted.clone(),
        fixture.home.path().to_path_buf(),
        Some(BASE_URL),
    );
    assert_eq!(
        restarted_importer
            .import(request(
                &retry_identity,
                &workspace,
                &binding,
                /*now*/ 500,
            ))
            .await
            .expect("resume pending import"),
        CloudAgentLegacySessionImportOutcome::Imported { turn_count: 2 }
    );
    assert_eq!(
        restarted_importer
            .import(request(
                &retry_identity,
                &workspace,
                &binding,
                /*now*/ 900,
            ))
            .await
            .expect("repeat completed import"),
        CloudAgentLegacySessionImportOutcome::Existing { turn_count: 2 }
    );

    let page = restarted
        .list_cloud_agent_turn_page(&CloudAgentTurnPageQuery {
            thread_id: THREAD_ID.to_string(),
            anchor: None,
            limit: 10,
            sort_direction: CloudAgentTurnSortDirection::Asc,
        })
        .await
        .expect("list imported Turns");
    assert_eq!(page.data.len(), 2);
    assert_eq!(page.data[0].status, CloudAgentTurnStatus::Completed);
    assert_eq!(page.data[0].origin.task_id(), None);
    assert_eq!(page.data[1].status, CloudAgentTurnStatus::Failed);
    assert_eq!(
        page.data[1].error_code.as_deref(),
        Some("legacyResponseMissing")
    );
    assert_eq!(page.data[0].created_at, 200);
    let prompt = restarted
        .get_artifact_record(
            &page.data[0].prompt_artifact.artifact_id,
            page.data[0].prompt_artifact.revision,
        )
        .await
        .expect("read imported prompt")
        .expect("imported prompt exists");
    assert_eq!(prompt.payload.content, Some(b"first question".to_vec()));
    assert_eq!(
        prompt.payload.retention_kind,
        ArtifactRetentionKind::UserManaged
    );
    assert_eq!(prompt.payload.created_at, 200);
    assert_eq!(
        restarted
            .get_cloud_agent_legacy_import(&journal_id)
            .await
            .expect("read completed journal")
            .expect("journal exists")
            .status,
        CloudAgentLegacyImportStatus::Completed
    );
    restarted.close().await;
}

fn request<'a>(
    identity: &'a crate::platform_control::RequestIdentity,
    workspace: &'a WorkspaceRef,
    binding: &'a ResolvedResourceBinding,
    now: i64,
) -> CloudAgentLegacySessionImportRequest<'a> {
    CloudAgentLegacySessionImportRequest {
        identity,
        workspace,
        execution_binding: binding,
        execution_binding_revision: 1,
        user_id: 42,
        thread_id: THREAD_ID,
        legacy_agent_id: "agent-1",
        now,
    }
}

async fn write_legacy_session(codex_home: &std::path::Path) {
    let namespace = format!("{:x}", Sha256::digest(BASE_URL));
    let root = codex_home.join("agent-platform-sessions").join(namespace);
    tokio::fs::create_dir_all(&root)
        .await
        .expect("create legacy history root");
    tokio::fs::write(
        root.join(format!(
            "{}.json",
            session_key(/*user_id*/ 42, THREAD_ID, "agent-1")
        )),
        serde_json::to_vec(&json!({
            "userId": 42,
            "threadId": THREAD_ID,
            "agentId": "agent-1",
            "messages": [
                {"role": "user", "content": "first question"},
                {"role": "assistant", "content": "first answer"},
                {"role": "user", "content": "unfinished question"}
            ]
        }))
        .expect("serialize legacy session"),
    )
    .await
    .expect("write legacy session");
}

fn workspace() -> WorkspaceRef {
    WorkspaceRef {
        workspace_key: WORKSPACE_KEY.to_string(),
        binding_id: "workspace-binding-1".to_string(),
        scope: WorkspaceScope::Conversation,
        scope_id: THREAD_ID.to_string(),
        node_id: "node-1".to_string(),
        environment_id: "local".to_string(),
    }
}

fn resolved_binding(
    record: &crewon_state::ProviderResourceBindingRecord,
) -> ResolvedResourceBinding {
    let provider = ProviderRef {
        provider_id: ProviderId::new(&record.provider_id).expect("provider id"),
        protocol_version: ProviderProtocolVersion::new(&record.protocol_version)
            .expect("protocol version"),
    };
    let resource = ResourceRef {
        provider: provider.clone(),
        kind: ResourceKind::Agent,
        resource_id: ResourceId::new(&record.resource_id).expect("resource id"),
        revision: ResourceRevision::new(&record.resource_revision).expect("resource revision"),
    };
    let capability = Capability {
        resource_kind: ResourceKind::Agent,
        binding_mode: BindingMode::ProviderManaged,
        execution_location: ExecutionLocation::Provider,
    };
    resolve_binding(
        &BindingRequest {
            binding_id: BindingId::new(&record.binding_id).expect("binding id"),
            workspace_key: WorkspaceKey::new(&record.workspace_key).expect("workspace key"),
            resource: resource.clone(),
            mode: BindingMode::ProviderManaged,
            execution_location: ExecutionLocation::Provider,
            materialization: None,
        },
        &ResourceManifest {
            resource,
            schema_version: ManifestSchemaVersion::new(&record.manifest_schema_version)
                .expect("schema version"),
            content_digest: None,
        },
        &ProviderCapabilities::new(provider, [capability]).expect("capabilities"),
    )
    .expect("resolved Agent binding")
}
