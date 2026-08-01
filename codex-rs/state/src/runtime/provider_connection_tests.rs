use pretty_assertions::assert_eq;

use super::StateRuntime;
use crate::ProviderConnectionResolveOutcome;
use crate::provider_connection_records_tests::connection_record;
use crate::runtime::test_support::unique_temp_dir;

#[tokio::test]
async fn provider_connection_resolves_once_and_round_trips_across_reopen() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let record = connection_record("provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c101");

    assert_eq!(
        runtime
            .resolve_provider_connection_record(&record)
            .await
            .expect("create provider connection"),
        ProviderConnectionResolveOutcome::Created(record.clone())
    );
    assert_eq!(
        runtime
            .resolve_provider_connection_record(&record)
            .await
            .expect("replay provider connection"),
        ProviderConnectionResolveOutcome::Existing(record.clone())
    );
    runtime.close().await;

    let reopened = initialized(&codex_home).await;
    assert_eq!(
        reopened
            .get_provider_connection_record(&record.connection_id)
            .await
            .expect("read reopened provider connection"),
        Some(record)
    );
    reopened.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn concurrent_same_selection_has_one_connection_and_authority_changes_are_independent() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let first = connection_record("provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c111");
    let mut second = first.clone();
    second.connection_id = "provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c112".to_string();
    second.record_hash = second.canonical_hash();

    let (first_result, second_result) = tokio::join!(
        runtime.resolve_provider_connection_record(&first),
        runtime.resolve_provider_connection_record(&second)
    );
    let winner = match (
        first_result.expect("first concurrent resolve"),
        second_result.expect("second concurrent resolve"),
    ) {
        (
            ProviderConnectionResolveOutcome::Created(created),
            ProviderConnectionResolveOutcome::Existing(existing),
        )
        | (
            ProviderConnectionResolveOutcome::Existing(existing),
            ProviderConnectionResolveOutcome::Created(created),
        ) => {
            assert_eq!(created, existing);
            created
        }
        other => panic!("unexpected concurrent outcomes: {other:?}"),
    };
    assert!(winner == first || winner == second);

    let mut changed_owner =
        connection_record("provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c113");
    changed_owner.local_actor_id = "actor-2".to_string();
    changed_owner.record_hash = changed_owner.canonical_hash();
    assert_eq!(
        runtime
            .resolve_provider_connection_record(&changed_owner)
            .await
            .expect("create changed owner connection"),
        ProviderConnectionResolveOutcome::Created(changed_owner.clone())
    );

    let mut changed_revision =
        connection_record("provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c114");
    changed_revision.credential_revision = 8;
    changed_revision.record_hash = changed_revision.canonical_hash();
    assert_eq!(
        runtime
            .resolve_provider_connection_record(&changed_revision)
            .await
            .expect("create changed revision connection"),
        ProviderConnectionResolveOutcome::Created(changed_revision)
    );

    let mut colliding_id = changed_owner;
    colliding_id.connection_id = winner.connection_id;
    colliding_id.record_hash = colliding_id.canonical_hash();
    assert_eq!(
        runtime
            .resolve_provider_connection_record(&colliding_id)
            .await
            .expect("connection id collision"),
        ProviderConnectionResolveOutcome::Conflict
    );

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn provider_connection_read_revalidates_persisted_hash() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let record = connection_record("provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c121");
    runtime
        .resolve_provider_connection_record(&record)
        .await
        .expect("create provider connection");

    sqlx::query("UPDATE provider_connections SET local_actor_id = ? WHERE connection_id = ?")
        .bind("actor-tampered")
        .bind(&record.connection_id)
        .execute(runtime.pool.as_ref())
        .await
        .expect("tamper provider connection");

    let error = runtime
        .get_provider_connection_record(&record.connection_id)
        .await
        .expect_err("tampered record must fail closed");
    assert!(error.to_string().contains("DigestMismatch"));

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn provider_connection_capacity_is_bounded_without_eviction() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let mut tx = runtime.pool.begin().await.expect("begin capacity fixture");
    for index in 0_u128..1_024 {
        sqlx::query(
            r#"
INSERT INTO provider_connections (
    connection_id, local_actor_id, local_tenant_id, local_space_id,
    provider_id, protocol_version, credential_id, credential_revision,
    record_hash, created_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(format!(
            "provider-connection:{}",
            uuid::Uuid::from_u128(index + 1)
        ))
        .bind(format!("actor-{index}"))
        .bind("tenant-fixture")
        .bind("space-fixture")
        .bind("agent-platform")
        .bind("3.0.0")
        .bind(format!("credential-{index}"))
        .bind(1_i64)
        .bind(format!("sha256:{index:064x}"))
        .bind(100_i64)
        .execute(&mut *tx)
        .await
        .expect("insert capacity fixture");
    }
    tx.commit().await.expect("commit capacity fixture");

    let proposed = connection_record("provider-connection:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c131");
    assert_eq!(
        runtime
            .resolve_provider_connection_record(&proposed)
            .await
            .expect("resolve at capacity"),
        ProviderConnectionResolveOutcome::CapacityExceeded
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM provider_connections")
            .fetch_one(runtime.pool.as_ref())
            .await
            .expect("count provider connections"),
        1_024
    );

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

async fn initialized(codex_home: &std::path::Path) -> std::sync::Arc<StateRuntime> {
    StateRuntime::init(codex_home.to_path_buf(), "test-provider".to_string())
        .await
        .expect("initialize state runtime")
}
