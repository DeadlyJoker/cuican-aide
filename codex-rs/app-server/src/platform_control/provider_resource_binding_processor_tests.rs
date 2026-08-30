use crewon_app_server_protocol::ResourceBindParams;
use crewon_app_server_protocol::ResourceBindingMode;
use crewon_app_server_protocol::ResourceBindingStatus;
use crewon_app_server_protocol::ResourceRef;
use crewon_app_server_protocol::ResourceType;
use crewon_app_server_protocol::WorkspaceRef;
use crewon_app_server_protocol::WorkspaceScope;
use crewon_state::DurableWorkspaceRootRecord;
use crewon_state::DurableWorkspaceRootResolveOutcome;
use crewon_state::ProviderAccessGrantRevokeRequest;
use pretty_assertions::assert_eq;

use super::provider_identity_adapter_tests::authenticated_identity_in_space;
use super::provider_resource_binding_processor::ProviderResourceBindingProcessor;
use super::provider_resource_binding_processor::ProviderResourceBindingProcessorError;
use super::provider_resource_binding_processor::unbind_resource_binding;
use super::provider_resource_catalog_tests::CatalogAction;
use super::provider_resource_catalog_tests::FixedClock;
use super::provider_resource_catalog_tests::Fixture;
use super::provider_resource_catalog_tests::RecordingCatalog;
use super::provider_resource_catalog_tests::RecordingCatalogFactory;
use super::provider_resource_catalog_tests::descriptor;
use super::provider_resource_catalog_tests::resource_manifest;
use super::provider_resource_catalog_tests::resource_ref;

#[tokio::test]
async fn resource_binding_core_binds_replays_unbinds_and_hides_cross_owner() {
    let fixture = Fixture::new().await;
    create_workspace_root(&fixture).await;
    let resource = resource_ref();
    let catalog = RecordingCatalog::new(
        descriptor("3.0.0"),
        crewon_resource_federation::ResourcePage::complete(vec![resource.clone()])
            .expect("resource page"),
        resource_manifest(resource),
        CatalogAction::Noop,
    );
    let factory = RecordingCatalogFactory::new(catalog);
    let processor = ProviderResourceBindingProcessor::new(
        fixture.state.as_ref(),
        &fixture.ready,
        &factory,
        &FixedClock,
    );
    let workspace = workspace();
    let params = bind_params(&workspace);

    let created = processor
        .bind(&fixture.identity, &workspace, params.clone())
        .await
        .expect("bind resource");
    let replayed = processor
        .bind(&fixture.identity, &workspace, params)
        .await
        .expect("replay resource bind");
    assert_eq!(replayed, created);
    assert_eq!(created.status, ResourceBindingStatus::Active);
    assert_eq!(created.revision, 1);

    let unbound = unbind_resource_binding(
        fixture.state.as_ref(),
        &fixture.identity,
        &created.binding.binding_id,
        /*now*/ 160,
    )
    .await
    .expect("unbind resource");
    assert_eq!(unbound.status, ResourceBindingStatus::Unbound);
    assert_eq!(unbound.revision, 2);
    assert_eq!(
        unbind_resource_binding(
            fixture.state.as_ref(),
            &fixture.identity,
            &created.binding.binding_id,
            /*now*/ 170,
        )
        .await
        .expect("replay resource unbind"),
        unbound
    );
    assert_eq!(
        unbind_resource_binding(
            fixture.state.as_ref(),
            &authenticated_identity_in_space("cross-owner", "12"),
            &created.binding.binding_id,
            /*now*/ 170,
        )
        .await
        .expect_err("cross-owner unbind hidden"),
        ProviderResourceBindingProcessorError::NotFound
    );

    fixture.state.close().await;
}

#[tokio::test]
async fn resource_binding_core_rejects_local_mode_without_materializer() {
    let fixture = Fixture::new().await;
    create_workspace_root(&fixture).await;
    let resource = resource_ref();
    let factory = RecordingCatalogFactory::new(RecordingCatalog::new(
        descriptor("3.0.0"),
        crewon_resource_federation::ResourcePage::complete(vec![resource.clone()])
            .expect("resource page"),
        resource_manifest(resource),
        CatalogAction::Noop,
    ));
    let processor = ProviderResourceBindingProcessor::new(
        fixture.state.as_ref(),
        &fixture.ready,
        &factory,
        &FixedClock,
    );
    let workspace = workspace();
    let mut params = bind_params(&workspace);
    params.mode = ResourceBindingMode::LocalSnapshot;

    assert_eq!(
        processor
            .bind(&fixture.identity, &workspace, params)
            .await
            .expect_err("local binding requires materializer"),
        ProviderResourceBindingProcessorError::Incompatible
    );

    fixture.state.close().await;
}

#[tokio::test]
async fn resource_binding_core_rechecks_authority_after_provider_io() {
    let fixture = Fixture::new().await;
    create_workspace_root(&fixture).await;
    let resource = resource_ref();
    let factory = RecordingCatalogFactory::new(RecordingCatalog::new(
        descriptor("3.0.0"),
        crewon_resource_federation::ResourcePage::complete(vec![resource.clone()])
            .expect("resource page"),
        resource_manifest(resource),
        CatalogAction::Revoke {
            state: fixture.state.clone(),
            request: ProviderAccessGrantRevokeRequest {
                grant_id: fixture.grant.grant_id.clone(),
                expected_revision: fixture.grant.revision,
                revoked_at: 151,
            },
        },
    ));
    let processor = ProviderResourceBindingProcessor::new(
        fixture.state.as_ref(),
        &fixture.ready,
        &factory,
        &FixedClock,
    );
    let workspace = workspace();

    assert_eq!(
        processor
            .bind(&fixture.identity, &workspace, bind_params(&workspace))
            .await
            .expect_err("authority drift rejected"),
        ProviderResourceBindingProcessorError::AuthorityChanged
    );

    fixture.state.close().await;
}

async fn create_workspace_root(fixture: &Fixture) {
    let mut root = DurableWorkspaceRootRecord {
        workspace_key: workspace().workspace_key,
        node_id: "node-1".to_string(),
        environment_id: "local".to_string(),
        root_fingerprint: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
            .to_string(),
        record_hash: String::new(),
        created_at: 90,
    };
    root.record_hash = root.canonical_hash();
    assert_eq!(
        fixture
            .state
            .resolve_durable_workspace_root_record(&root)
            .await
            .expect("create durable workspace root"),
        DurableWorkspaceRootResolveOutcome::Created(root)
    );
}

fn workspace() -> WorkspaceRef {
    WorkspaceRef {
        workspace_key: "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c001".to_string(),
        binding_id: "binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c201".to_string(),
        scope: WorkspaceScope::Office,
        scope_id: "office-1".to_string(),
        node_id: "node-1".to_string(),
        environment_id: "local".to_string(),
    }
}

fn bind_params(workspace: &WorkspaceRef) -> ResourceBindParams {
    ResourceBindParams {
        connection_id: "provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c201".to_string(),
        workspace_binding_id: workspace.binding_id.clone(),
        resource: ResourceRef {
            provider_id: "agent-platform".to_string(),
            resource_id: "agent-demo".to_string(),
            revision: "agent-version:7".to_string(),
            resource_type: ResourceType::Agent,
        },
        mode: ResourceBindingMode::ProviderManaged,
    }
}
