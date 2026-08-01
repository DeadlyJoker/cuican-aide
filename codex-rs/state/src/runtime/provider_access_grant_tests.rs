use pretty_assertions::assert_eq;

use super::StateRuntime;
use crate::ProviderAccessGrantLookup;
use crate::ProviderAccessGrantOwnerLookup;
use crate::ProviderAccessGrantRefreshOutcome;
use crate::ProviderAccessGrantRefreshRequest;
use crate::ProviderAccessGrantReplaceOutcome;
use crate::ProviderAccessGrantReplaceRequest;
use crate::ProviderAccessGrantResolveOutcome;
use crate::ProviderAccessGrantRevokeOutcome;
use crate::ProviderAccessGrantRevokeRequest;
use crate::provider_access_grant_records_tests::access_grant_record;
use crate::runtime::test_support::unique_temp_dir;

#[tokio::test]
async fn provider_access_grant_resolves_reads_expires_and_reopens() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let record = access_grant_record("provider-grant:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c301");
    let lookup = lookup(&record);

    assert_eq!(
        runtime
            .resolve_provider_access_grant_record(&record)
            .await
            .expect("create grant"),
        ProviderAccessGrantResolveOutcome::Created(record.clone())
    );
    assert_eq!(
        runtime
            .resolve_provider_access_grant_record(&record)
            .await
            .expect("replay grant"),
        ProviderAccessGrantResolveOutcome::Existing(record.clone())
    );
    assert_eq!(
        runtime
            .get_active_provider_access_grant_record(&lookup, /*now*/ 150)
            .await
            .expect("read active grant"),
        Some(record.clone())
    );
    assert_eq!(
        runtime
            .get_active_provider_access_grant_record(&lookup, /*now*/ 200)
            .await
            .expect("read expired grant"),
        None
    );
    assert_eq!(
        runtime
            .get_current_provider_access_grant_record(&owner_lookup(&record))
            .await
            .expect("read current expired grant"),
        Some(record.clone())
    );
    runtime.close().await;

    let reopened = initialized(&codex_home).await;
    assert_eq!(
        reopened
            .get_provider_access_grant_record(&record.grant_id)
            .await
            .expect("read reopened grant"),
        Some(record)
    );
    reopened.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn active_provider_access_grant_expiry_refresh_preserves_identity() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let record = access_grant_record("provider-grant:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c302");
    runtime
        .resolve_provider_access_grant_record(&record)
        .await
        .expect("create grant");
    let request = ProviderAccessGrantRefreshRequest {
        grant_id: record.grant_id.clone(),
        expected_revision: record.revision,
        expected_expires_at: record.expires_at,
        refreshed_expires_at: 300,
        refreshed_at: 150,
    };
    let mut refreshed = record.clone();
    refreshed.expires_at = request.refreshed_expires_at;
    refreshed.record_hash = refreshed.canonical_hash();

    assert_eq!(
        runtime
            .refresh_provider_access_grant_record(&request)
            .await
            .expect("refresh grant"),
        ProviderAccessGrantRefreshOutcome::Refreshed(refreshed.clone())
    );
    assert_eq!(
        runtime
            .refresh_provider_access_grant_record(&request)
            .await
            .expect("replay refresh"),
        ProviderAccessGrantRefreshOutcome::Existing(refreshed.clone())
    );
    assert_eq!(
        runtime
            .get_active_provider_access_grant_record(&lookup(&record), /*now*/ 250)
            .await
            .expect("read refreshed grant"),
        Some(refreshed)
    );

    let stale = ProviderAccessGrantRefreshRequest {
        expected_revision: 2,
        refreshed_expires_at: 350,
        ..request
    };
    assert_eq!(
        runtime
            .refresh_provider_access_grant_record(&stale)
            .await
            .expect("reject stale refresh"),
        ProviderAccessGrantRefreshOutcome::Conflict
    );

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn concurrent_exact_authority_has_one_grant_and_drift_conflicts() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let first = access_grant_record("provider-grant:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c311");
    let mut second = first.clone();
    second.grant_id = "provider-grant:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c312".to_string();
    second.record_hash = second.canonical_hash();

    let (first_result, second_result) = tokio::join!(
        runtime.resolve_provider_access_grant_record(&first),
        runtime.resolve_provider_access_grant_record(&second)
    );
    let winner = match (
        first_result.expect("first concurrent resolve"),
        second_result.expect("second concurrent resolve"),
    ) {
        (
            ProviderAccessGrantResolveOutcome::Created(created),
            ProviderAccessGrantResolveOutcome::Existing(existing),
        )
        | (
            ProviderAccessGrantResolveOutcome::Existing(existing),
            ProviderAccessGrantResolveOutcome::Created(created),
        ) => {
            assert_eq!(created, existing);
            created
        }
        other => panic!("unexpected concurrent outcomes: {other:?}"),
    };
    assert!(winner == first || winner == second);

    let mut scope_drift =
        access_grant_record("provider-grant:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c313");
    scope_drift.granted_scopes = vec!["provider.discovery".to_string()];
    scope_drift.record_hash = scope_drift.canonical_hash();
    assert_eq!(
        runtime
            .resolve_provider_access_grant_record(&scope_drift)
            .await
            .expect("scope drift"),
        ProviderAccessGrantResolveOutcome::Conflict
    );

    let mut source_drift =
        access_grant_record("provider-grant:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c314");
    source_drift.source_revision = 2;
    source_drift.record_hash = source_drift.canonical_hash();
    assert_eq!(
        runtime
            .resolve_provider_access_grant_record(&source_drift)
            .await
            .expect("source drift"),
        ProviderAccessGrantResolveOutcome::Conflict
    );

    let mut source_mixup =
        access_grant_record("provider-grant:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c315");
    source_mixup.local_actor_id =
        "principal:7f7900eaed3218b4c15249cad129ed96bf1bde4d0524fa4b6fad1ba325e8ef3f".to_string();
    source_mixup.record_hash = source_mixup.canonical_hash();
    assert_eq!(
        runtime
            .resolve_provider_access_grant_record(&source_mixup)
            .await
            .expect("source binding mix-up"),
        ProviderAccessGrantResolveOutcome::Conflict
    );

    let mut other_owner = source_mixup;
    other_owner.source_binding_id = "019f6f00-0000-7000-8000-000000000002".to_string();
    other_owner.record_hash = other_owner.canonical_hash();
    assert_eq!(
        runtime
            .resolve_provider_access_grant_record(&other_owner)
            .await
            .expect("other owner"),
        ProviderAccessGrantResolveOutcome::Created(other_owner)
    );

    let mut colliding_id = scope_drift;
    colliding_id.grant_id = winner.grant_id;
    colliding_id.record_hash = colliding_id.canonical_hash();
    assert_eq!(
        runtime
            .resolve_provider_access_grant_record(&colliding_id)
            .await
            .expect("grant id collision"),
        ProviderAccessGrantResolveOutcome::Conflict
    );

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn revoke_is_cas_idempotent_and_allows_new_grant_after_terminal_state() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let record = access_grant_record("provider-grant:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c321");
    runtime
        .resolve_provider_access_grant_record(&record)
        .await
        .expect("create grant");
    let mut widened = record.clone();
    widened.grant_id = "provider-grant:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c320".to_string();
    widened
        .granted_scopes
        .push("providerRun:toolResult".to_string());
    widened.expires_at = 250;
    widened.created_at = 150;
    widened.updated_at = 150;
    widened.record_hash = widened.canonical_hash();
    assert_eq!(
        runtime
            .replace_provider_access_grant_record(&ProviderAccessGrantReplaceRequest {
                current_grant_id: record.grant_id.clone(),
                expected_revision: record.revision,
                replacement: widened,
                replaced_at: 150,
            })
            .await
            .expect("scope widening replacement"),
        ProviderAccessGrantReplaceOutcome::Conflict
    );
    let request = ProviderAccessGrantRevokeRequest {
        grant_id: record.grant_id.clone(),
        expected_revision: 1,
        revoked_at: 160,
    };

    assert_eq!(
        runtime
            .revoke_provider_access_grant_record(&request)
            .await
            .expect("revoke grant"),
        ProviderAccessGrantRevokeOutcome::Revoked
    );
    assert_eq!(
        runtime
            .revoke_provider_access_grant_record(&request)
            .await
            .expect("replay revoke"),
        ProviderAccessGrantRevokeOutcome::ExistingRevoked
    );
    assert_eq!(
        runtime
            .get_active_provider_access_grant_record(&lookup(&record), /*now*/ 161)
            .await
            .expect("revoked grant is inactive"),
        None
    );

    let mut replacement =
        access_grant_record("provider-grant:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c322");
    replacement.source_revision = 2;
    replacement.created_at = 161;
    replacement.updated_at = 161;
    replacement.expires_at = 260;
    replacement.record_hash = replacement.canonical_hash();
    assert_eq!(
        runtime
            .resolve_provider_access_grant_record(&replacement)
            .await
            .expect("replacement grant"),
        ProviderAccessGrantResolveOutcome::Created(replacement)
    );

    let stale = ProviderAccessGrantRevokeRequest {
        grant_id: record.grant_id,
        expected_revision: 2,
        revoked_at: 170,
    };
    assert_eq!(
        runtime
            .revoke_provider_access_grant_record(&stale)
            .await
            .expect("stale revoke"),
        ProviderAccessGrantRevokeOutcome::Conflict
    );

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn persisted_tamper_fails_closed() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let record = access_grant_record("provider-grant:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c331");
    runtime
        .resolve_provider_access_grant_record(&record)
        .await
        .expect("create grant");
    sqlx::query("UPDATE provider_access_grants SET local_space_id = ? WHERE grant_id = ?")
        .bind("12")
        .bind(&record.grant_id)
        .execute(runtime.pool.as_ref())
        .await
        .expect("tamper grant");

    let error = runtime
        .get_provider_access_grant_record(&record.grant_id)
        .await
        .expect_err("tampered grant must fail closed");
    assert!(error.to_string().contains("DigestMismatch"));

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn provider_access_grant_capacity_is_bounded_without_eviction() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let mut tx = runtime.pool.begin().await.expect("begin capacity fixture");
    for index in 0_u128..1_024 {
        sqlx::query(
            r#"
INSERT INTO provider_access_grants (
    grant_id, local_actor_id, local_tenant_id, local_space_id, provider_id,
    source_binding_id, source_revision, granted_scopes_json, status, expires_at,
    revision, record_hash, created_at, updated_at, revoked_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 1, ?, 100, 100, NULL)
            "#,
        )
        .bind(format!(
            "provider-grant:{}",
            uuid::Uuid::from_u128(index + 1)
        ))
        .bind(format!("principal:{index:064x}"))
        .bind("tenant-fixture")
        .bind("space-fixture")
        .bind("agent-platform")
        .bind(uuid::Uuid::from_u128(index + 1).to_string())
        .bind(1_i64)
        .bind(r#"["provider.discovery"]"#)
        .bind(200_i64)
        .bind(format!("sha256:{index:064x}"))
        .execute(&mut *tx)
        .await
        .expect("insert capacity fixture");
    }
    tx.commit().await.expect("commit capacity fixture");

    let proposed = access_grant_record("provider-grant:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c341");
    assert_eq!(
        runtime
            .resolve_provider_access_grant_record(&proposed)
            .await
            .expect("resolve at capacity"),
        ProviderAccessGrantResolveOutcome::CapacityExceeded
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM provider_access_grants")
            .fetch_one(runtime.pool.as_ref())
            .await
            .expect("count grants"),
        1_024
    );

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn replacement_at_capacity_preserves_current_authority_without_partial_revoke() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let current = access_grant_record("provider-grant:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c351");
    runtime
        .resolve_provider_access_grant_record(&current)
        .await
        .expect("create current grant");

    let mut tx = runtime.pool.begin().await.expect("begin capacity fixture");
    for index in 1_u128..1_024 {
        sqlx::query(
            r#"
INSERT INTO provider_access_grants (
    grant_id, local_actor_id, local_tenant_id, local_space_id, provider_id,
    source_binding_id, source_revision, granted_scopes_json, status, expires_at,
    revision, record_hash, created_at, updated_at, revoked_at
) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'active', 200, 1, ?, 100, 100, NULL)
            "#,
        )
        .bind(format!("provider-grant:{}", uuid::Uuid::from_u128(index)))
        .bind(format!("principal:{index:064x}"))
        .bind("tenant-fixture")
        .bind("space-fixture")
        .bind("agent-platform")
        .bind(uuid::Uuid::from_u128(index).to_string())
        .bind(r#"["provider.discovery"]"#)
        .bind(format!("sha256:{index:064x}"))
        .execute(&mut *tx)
        .await
        .expect("insert capacity fixture");
    }
    tx.commit().await.expect("commit capacity fixture");

    let mut replacement = current.clone();
    replacement.grant_id = "provider-grant:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c352".to_string();
    replacement.expires_at = 300;
    replacement.created_at = 150;
    replacement.updated_at = 150;
    replacement.record_hash = replacement.canonical_hash();
    assert_eq!(
        runtime
            .replace_provider_access_grant_record(&ProviderAccessGrantReplaceRequest {
                current_grant_id: current.grant_id.clone(),
                expected_revision: current.revision,
                replacement,
                replaced_at: 150,
            })
            .await
            .expect("replace at capacity"),
        ProviderAccessGrantReplaceOutcome::CapacityExceeded
    );
    assert_eq!(
        runtime
            .get_provider_access_grant_record(&current.grant_id)
            .await
            .expect("read current after rejected replacement"),
        Some(current)
    );

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

fn lookup(record: &crate::ProviderAccessGrantRecord) -> ProviderAccessGrantLookup {
    ProviderAccessGrantLookup {
        local_actor_id: record.local_actor_id.clone(),
        local_tenant_id: record.local_tenant_id.clone(),
        local_space_id: record.local_space_id.clone(),
        provider_id: record.provider_id.clone(),
        source_binding_id: record.source_binding_id.clone(),
        source_revision: record.source_revision,
    }
}

fn owner_lookup(record: &crate::ProviderAccessGrantRecord) -> ProviderAccessGrantOwnerLookup {
    ProviderAccessGrantOwnerLookup {
        local_actor_id: record.local_actor_id.clone(),
        local_tenant_id: record.local_tenant_id.clone(),
        local_space_id: record.local_space_id.clone(),
        provider_id: record.provider_id.clone(),
    }
}

async fn initialized(codex_home: &std::path::Path) -> std::sync::Arc<StateRuntime> {
    StateRuntime::init(codex_home.to_path_buf(), "test-provider".to_string())
        .await
        .expect("initialize state runtime")
}
