use pretty_assertions::assert_eq;

use super::StateRuntime;
use crate::DurableWorkspaceRootResolveOutcome;
use crate::ProviderConnectionResolveOutcome;
use crate::ProviderResourceBindingResolveOutcome;
use crate::ProviderResourceBindingStatus;
use crate::ProviderResourceBindingUnbindOutcome;
use crate::ProviderResourceBindingUnbindRequest;
use crate::durable_workspace_records_tests::root_record;
use crate::provider_connection_records_tests::connection_record;
use crate::provider_resource_binding_records_tests::binding_record;
use crate::runtime::test_support::unique_temp_dir;

#[tokio::test]
async fn provider_resource_binding_resolves_reactivates_and_reopens() {
    let codex_home = unique_temp_dir();
    let runtime = initialized_with_parents(&codex_home).await;
    let record = binding_record("resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c401");

    assert_eq!(
        runtime
            .resolve_provider_resource_binding_record(&record)
            .await
            .expect("create resource binding"),
        ProviderResourceBindingResolveOutcome::Created(record.clone())
    );
    assert_eq!(
        runtime
            .resolve_provider_resource_binding_record(&record)
            .await
            .expect("replay resource binding"),
        ProviderResourceBindingResolveOutcome::Existing(record.clone())
    );

    let mut unbound = record.clone();
    unbound.status = ProviderResourceBindingStatus::Unbound;
    unbound.revision = 2;
    unbound.updated_at = 110;
    unbound.unbound_at = Some(110);
    unbound.record_hash = unbound.canonical_hash();
    sqlx::query(
        "UPDATE provider_resource_bindings SET status = ?, revision = ?, record_hash = ?, updated_at = ?, unbound_at = ? WHERE binding_id = ?",
    )
    .bind(unbound.status.as_str())
    .bind(i64::try_from(unbound.revision).expect("revision"))
    .bind(&unbound.record_hash)
    .bind(unbound.updated_at)
    .bind(unbound.unbound_at)
    .bind(&unbound.binding_id)
    .execute(runtime.pool.as_ref())
    .await
    .expect("seed unbound record");

    let mut rebound = binding_record("resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c402");
    rebound.created_at = 120;
    rebound.updated_at = 120;
    rebound.record_hash = rebound.canonical_hash();
    let mut expected = unbound;
    expected.status = ProviderResourceBindingStatus::Active;
    expected.revision = 3;
    expected.updated_at = 120;
    expected.unbound_at = None;
    expected.record_hash = expected.canonical_hash();
    assert_eq!(
        runtime
            .resolve_provider_resource_binding_record(&rebound)
            .await
            .expect("reactivate resource binding"),
        ProviderResourceBindingResolveOutcome::Reactivated(expected.clone())
    );
    runtime.close().await;

    let reopened = initialized(&codex_home).await;
    assert_eq!(
        reopened
            .get_provider_resource_binding_record(&expected.binding_id)
            .await
            .expect("read reopened resource binding"),
        Some(expected)
    );
    reopened.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn concurrent_resource_binding_resolve_checks_parents_and_selection() {
    let codex_home = unique_temp_dir();
    let runtime = initialized_with_parents(&codex_home).await;
    let first = binding_record("resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c411");
    let mut second = first.clone();
    second.binding_id = "resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c412".to_string();
    second.record_hash = second.canonical_hash();

    let (first_result, second_result) = tokio::join!(
        runtime.resolve_provider_resource_binding_record(&first),
        runtime.resolve_provider_resource_binding_record(&second)
    );
    let winner = match (
        first_result.expect("first concurrent resolve"),
        second_result.expect("second concurrent resolve"),
    ) {
        (
            ProviderResourceBindingResolveOutcome::Created(created),
            ProviderResourceBindingResolveOutcome::Existing(existing),
        )
        | (
            ProviderResourceBindingResolveOutcome::Existing(existing),
            ProviderResourceBindingResolveOutcome::Created(created),
        ) => {
            assert_eq!(created, existing);
            created
        }
        other => panic!("unexpected concurrent outcomes: {other:?}"),
    };

    let mut missing_connection =
        binding_record("resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c413");
    missing_connection.connection_id =
        "provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c199".to_string();
    missing_connection.resource_id = "agent-missing-connection".to_string();
    missing_connection.record_hash = missing_connection.canonical_hash();
    assert_eq!(
        runtime
            .resolve_provider_resource_binding_record(&missing_connection)
            .await
            .expect("missing connection outcome"),
        ProviderResourceBindingResolveOutcome::ConnectionNotFound
    );

    let mut missing_workspace =
        binding_record("resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c414");
    missing_workspace.workspace_key = "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c099".to_string();
    missing_workspace.resource_id = "agent-missing-workspace".to_string();
    missing_workspace.record_hash = missing_workspace.canonical_hash();
    assert_eq!(
        runtime
            .resolve_provider_resource_binding_record(&missing_workspace)
            .await
            .expect("missing workspace outcome"),
        ProviderResourceBindingResolveOutcome::WorkspaceNotFound
    );

    let mut parent_mismatch =
        binding_record("resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c415");
    parent_mismatch.local_actor_id = "actor-2".to_string();
    parent_mismatch.resource_id = "agent-parent-mismatch".to_string();
    parent_mismatch.record_hash = parent_mismatch.canonical_hash();
    assert_eq!(
        runtime
            .resolve_provider_resource_binding_record(&parent_mismatch)
            .await
            .expect("parent mismatch outcome"),
        ProviderResourceBindingResolveOutcome::ParentMismatch
    );

    let mut colliding_id = binding_record(&winner.binding_id);
    colliding_id.resource_id = "agent-collision".to_string();
    colliding_id.record_hash = colliding_id.canonical_hash();
    assert_eq!(
        runtime
            .resolve_provider_resource_binding_record(&colliding_id)
            .await
            .expect("binding id collision"),
        ProviderResourceBindingResolveOutcome::Conflict
    );

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn resource_binding_unbind_is_owner_scoped_cas_and_idempotent() {
    let codex_home = unique_temp_dir();
    let runtime = initialized_with_parents(&codex_home).await;
    let record = binding_record("resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c421");
    runtime
        .resolve_provider_resource_binding_record(&record)
        .await
        .expect("create resource binding");
    let request = unbind_request(&record, 110);

    let mut cross_owner = request.clone();
    cross_owner.local_actor_id = "actor-2".to_string();
    assert_eq!(
        runtime
            .unbind_provider_resource_binding_record(&cross_owner)
            .await
            .expect("cross-owner unbind"),
        ProviderResourceBindingUnbindOutcome::NotFound
    );
    let mut missing = request.clone();
    missing.binding_id = "resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c499".to_string();
    assert_eq!(
        runtime
            .unbind_provider_resource_binding_record(&missing)
            .await
            .expect("missing unbind"),
        ProviderResourceBindingUnbindOutcome::NotFound
    );
    let mut time_rollback = request.clone();
    time_rollback.unbound_at = 99;
    assert_eq!(
        runtime
            .unbind_provider_resource_binding_record(&time_rollback)
            .await
            .expect("time rollback unbind"),
        ProviderResourceBindingUnbindOutcome::Conflict
    );

    assert_eq!(
        runtime
            .unbind_provider_resource_binding_record(&request)
            .await
            .expect("unbind resource binding"),
        ProviderResourceBindingUnbindOutcome::Unbound
    );
    assert_eq!(
        runtime
            .unbind_provider_resource_binding_record(&request)
            .await
            .expect("replay resource unbind"),
        ProviderResourceBindingUnbindOutcome::ExistingUnbound
    );
    let mut stale = request;
    stale.expected_revision = 2;
    assert_eq!(
        runtime
            .unbind_provider_resource_binding_record(&stale)
            .await
            .expect("stale resource unbind"),
        ProviderResourceBindingUnbindOutcome::Conflict
    );

    let persisted = runtime
        .get_provider_resource_binding_record(&record.binding_id)
        .await
        .expect("read unbound resource binding")
        .expect("resource binding exists");
    assert_eq!(persisted.status, ProviderResourceBindingStatus::Unbound);
    assert_eq!(persisted.revision, 2);
    assert_eq!(persisted.unbound_at, Some(110));

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn concurrent_unbind_and_reactivate_are_serializable() {
    let codex_home = unique_temp_dir();
    let runtime = initialized_with_parents(&codex_home).await;
    let record = binding_record("resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c431");
    runtime
        .resolve_provider_resource_binding_record(&record)
        .await
        .expect("create resource binding");
    let request = unbind_request(&record, 110);
    let mut rebound = binding_record("resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c432");
    rebound.created_at = 120;
    rebound.updated_at = 120;
    rebound.record_hash = rebound.canonical_hash();

    let (unbind_result, resolve_result) = tokio::join!(
        runtime.unbind_provider_resource_binding_record(&request),
        runtime.resolve_provider_resource_binding_record(&rebound)
    );
    let unbind_outcome = unbind_result.expect("concurrent unbind");
    let resolve_outcome = resolve_result.expect("concurrent reactivate");
    assert_eq!(
        unbind_outcome,
        ProviderResourceBindingUnbindOutcome::Unbound
    );

    let persisted = runtime
        .get_provider_resource_binding_record(&record.binding_id)
        .await
        .expect("read concurrent result")
        .expect("resource binding exists");
    match resolve_outcome {
        ProviderResourceBindingResolveOutcome::Existing(existing) => {
            assert_eq!(existing, record);
            assert_eq!(persisted.status, ProviderResourceBindingStatus::Unbound);
            assert_eq!(persisted.revision, 2);
        }
        ProviderResourceBindingResolveOutcome::Reactivated(reactivated) => {
            assert_eq!(persisted, reactivated);
            assert_eq!(persisted.status, ProviderResourceBindingStatus::Active);
            assert_eq!(persisted.revision, 3);
        }
        other => panic!("unexpected concurrent resolve outcome: {other:?}"),
    }

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn resource_binding_persisted_tamper_fails_closed() {
    let codex_home = unique_temp_dir();
    let runtime = initialized_with_parents(&codex_home).await;
    let record = binding_record("resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c441");
    runtime
        .resolve_provider_resource_binding_record(&record)
        .await
        .expect("create resource binding");
    sqlx::query("UPDATE provider_resource_bindings SET resource_id = ? WHERE binding_id = ?")
        .bind("agent-tampered")
        .bind(&record.binding_id)
        .execute(runtime.pool.as_ref())
        .await
        .expect("tamper resource binding");

    let error = runtime
        .get_provider_resource_binding_record(&record.binding_id)
        .await
        .expect_err("tampered resource binding must fail closed");
    assert!(error.to_string().contains("DigestMismatch"));

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn provider_resource_binding_capacity_is_bounded_without_eviction() {
    let codex_home = unique_temp_dir();
    let runtime = initialized_with_parents(&codex_home).await;
    let mut tx = runtime.pool.begin().await.expect("begin capacity fixture");
    for index in 0_u128..1_024 {
        sqlx::query(
            r#"
INSERT INTO provider_resource_bindings (
    binding_id, local_actor_id, local_tenant_id, local_space_id,
    connection_id, workspace_key, workspace_scope, workspace_scope_id,
    provider_id, protocol_version, resource_kind, resource_id, resource_revision,
    binding_mode, execution_location, manifest_schema_version, content_digest,
    source_revision, source_digest, local_revision, local_content_digest,
    status, revision, record_hash, created_at, updated_at, unbound_at
) VALUES (?, 'actor-1', 'tenant-1', 'space-1', ?, ?, 'office', 'office-1',
          'agent-platform', '3.0.0', 'agent', ?, 'agent-version:7',
          'providerManaged', 'provider', '1.0.0', NULL,
          NULL, NULL, NULL, NULL, 'active', 1, ?, 100, 100, NULL)
            "#,
        )
        .bind(format!(
            "resource-binding:{}",
            uuid::Uuid::from_u128(index + 1)
        ))
        .bind("provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101")
        .bind("workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c001")
        .bind(format!("agent-capacity-{index}"))
        .bind(format!("sha256:{index:064x}"))
        .execute(&mut *tx)
        .await
        .expect("insert capacity fixture");
    }
    tx.commit().await.expect("commit capacity fixture");

    let mut proposed = binding_record("resource-binding:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c451");
    proposed.resource_id = "agent-over-capacity".to_string();
    proposed.record_hash = proposed.canonical_hash();
    assert_eq!(
        runtime
            .resolve_provider_resource_binding_record(&proposed)
            .await
            .expect("resolve at capacity"),
        ProviderResourceBindingResolveOutcome::CapacityExceeded
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM provider_resource_bindings")
            .fetch_one(runtime.pool.as_ref())
            .await
            .expect("count resource bindings"),
        1_024
    );

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

fn unbind_request(
    record: &crate::ProviderResourceBindingRecord,
    unbound_at: i64,
) -> ProviderResourceBindingUnbindRequest {
    ProviderResourceBindingUnbindRequest {
        binding_id: record.binding_id.clone(),
        local_actor_id: record.local_actor_id.clone(),
        local_tenant_id: record.local_tenant_id.clone(),
        local_space_id: record.local_space_id.clone(),
        expected_revision: record.revision,
        unbound_at,
    }
}

async fn initialized_with_parents(codex_home: &std::path::Path) -> std::sync::Arc<StateRuntime> {
    let runtime = initialized(codex_home).await;
    let root = root_record(
        "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c001",
        &format!("sha256:{}", "c".repeat(64)),
    );
    assert_eq!(
        runtime
            .resolve_durable_workspace_root_record(&root)
            .await
            .expect("create durable workspace"),
        DurableWorkspaceRootResolveOutcome::Created(root)
    );
    let connection = connection_record("provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101");
    assert_eq!(
        runtime
            .resolve_provider_connection_record(&connection)
            .await
            .expect("create Provider connection"),
        ProviderConnectionResolveOutcome::Created(connection)
    );
    runtime
}

async fn initialized(codex_home: &std::path::Path) -> std::sync::Arc<StateRuntime> {
    StateRuntime::init(codex_home.to_path_buf(), "test-provider".to_string())
        .await
        .expect("initialize state runtime")
}
