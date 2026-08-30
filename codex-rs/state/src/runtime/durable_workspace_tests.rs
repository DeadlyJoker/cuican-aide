use pretty_assertions::assert_eq;

use super::StateRuntime;
use crate::DurableWorkspaceRootResolveOutcome;
use crate::durable_workspace_records_tests::root_record;
use crate::runtime::test_support::unique_temp_dir;

#[tokio::test]
async fn durable_workspace_root_resolves_once_and_round_trips_across_reopen() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let record = root_record(
        "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c001",
        &format!("sha256:{}", "a".repeat(64)),
    );

    assert_eq!(
        runtime
            .resolve_durable_workspace_root_record(&record)
            .await
            .expect("create durable workspace root"),
        DurableWorkspaceRootResolveOutcome::Created(record.clone())
    );
    assert_eq!(
        runtime
            .resolve_durable_workspace_root_record(&record)
            .await
            .expect("replay durable workspace root"),
        DurableWorkspaceRootResolveOutcome::Existing(record.clone())
    );
    runtime.close().await;

    let reopened = initialized(&codex_home).await;
    assert_eq!(
        reopened
            .get_durable_workspace_root_record(&record.workspace_key)
            .await
            .expect("read reopened durable workspace root"),
        Some(record)
    );
    reopened.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn concurrent_same_root_has_one_workspace_key_and_distinct_roots_stay_independent() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let first = root_record(
        "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c011",
        &format!("sha256:{}", "b".repeat(64)),
    );
    let mut second = first.clone();
    second.workspace_key = "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c012".to_string();
    second.record_hash = second.canonical_hash();

    let (first_result, second_result) = tokio::join!(
        runtime.resolve_durable_workspace_root_record(&first),
        runtime.resolve_durable_workspace_root_record(&second)
    );
    let outcomes = (
        first_result.expect("first concurrent resolve"),
        second_result.expect("second concurrent resolve"),
    );
    let winner = match outcomes {
        (
            DurableWorkspaceRootResolveOutcome::Created(created),
            DurableWorkspaceRootResolveOutcome::Existing(existing),
        )
        | (
            DurableWorkspaceRootResolveOutcome::Existing(existing),
            DurableWorkspaceRootResolveOutcome::Created(created),
        ) => {
            assert_eq!(created, existing);
            created
        }
        other => panic!("unexpected concurrent outcomes: {other:?}"),
    };
    assert!(winner == first || winner == second);

    let distinct = root_record(
        "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c013",
        &format!("sha256:{}", "c".repeat(64)),
    );
    assert_eq!(
        runtime
            .resolve_durable_workspace_root_record(&distinct)
            .await
            .expect("create distinct root"),
        DurableWorkspaceRootResolveOutcome::Created(distinct.clone())
    );
    assert_ne!(winner.workspace_key, distinct.workspace_key);

    let mut colliding_key =
        root_record(&winner.workspace_key, &format!("sha256:{}", "d".repeat(64)));
    colliding_key.record_hash = colliding_key.canonical_hash();
    assert_eq!(
        runtime
            .resolve_durable_workspace_root_record(&colliding_key)
            .await
            .expect("workspace key collision"),
        DurableWorkspaceRootResolveOutcome::Conflict
    );

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn durable_workspace_root_read_revalidates_persisted_hash() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let record = root_record(
        "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c021",
        &format!("sha256:{}", "e".repeat(64)),
    );
    runtime
        .resolve_durable_workspace_root_record(&record)
        .await
        .expect("create root");

    sqlx::query("UPDATE durable_workspace_roots SET root_fingerprint = ? WHERE workspace_key = ?")
        .bind(format!("sha256:{}", "f".repeat(64)))
        .bind(&record.workspace_key)
        .execute(runtime.pool.as_ref())
        .await
        .expect("tamper durable workspace root");

    let error = runtime
        .get_durable_workspace_root_record(&record.workspace_key)
        .await
        .expect_err("tampered record must fail closed");
    assert!(error.to_string().contains("DigestMismatch"));

    runtime.close().await;
    let _ = tokio::fs::remove_dir_all(codex_home).await;
}

#[tokio::test]
async fn durable_workspace_root_capacity_is_bounded_without_eviction() {
    let codex_home = unique_temp_dir();
    let runtime = initialized(&codex_home).await;
    let mut tx = runtime.pool.begin().await.expect("begin capacity fixture");
    for index in 0_u128..1_024 {
        let workspace_key = format!("workspace:{}", uuid::Uuid::from_u128(index + 1));
        sqlx::query(
            r#"
INSERT INTO durable_workspace_roots (
    workspace_key, node_id, environment_id, root_fingerprint, record_hash, created_at
) VALUES (?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(workspace_key)
        .bind("fixture-node")
        .bind("local")
        .bind(format!("sha256:{index:064x}"))
        .bind(format!("sha256:{:064x}", index + 1))
        .bind(100_i64)
        .execute(&mut *tx)
        .await
        .expect("insert capacity fixture");
    }
    tx.commit().await.expect("commit capacity fixture");

    let proposed = root_record(
        "workspace:018f0d8e-7e6a-7cb2-8b34-7b2ca4d5c031",
        &format!("sha256:{}", "9".repeat(64)),
    );
    assert_eq!(
        runtime
            .resolve_durable_workspace_root_record(&proposed)
            .await
            .expect("resolve at capacity"),
        DurableWorkspaceRootResolveOutcome::CapacityExceeded
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM durable_workspace_roots")
            .fetch_one(runtime.pool.as_ref())
            .await
            .expect("count durable workspace roots"),
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
