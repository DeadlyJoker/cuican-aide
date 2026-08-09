use std::sync::mpsc;
use std::time::Duration;

use pretty_assertions::assert_eq;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::TransactionBehavior;
use serde_json::json;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::process::TerminatedPayload;
use tempfile::tempdir;

use super::environment::worker_environment;
use super::environment::ChildEnvironmentValue;
use super::process::wait_for_ready;
use super::process::wait_for_successful_exit;
use super::random_secret;
use super::reload::active_run_sql;
use super::ControlRuntimeSupervisor;
use super::RuntimeLifecycle;
use super::SessionMaterial;
use crate::provider_credentials::ActiveProviderBinding;
use crate::provider_credentials::ActiveProviderRuntime;
use crate::provider_credentials::ProviderCredentialKind;
use zeroize::Zeroizing;

#[test]
fn bootstrap_serializes_the_exact_renderer_contract() {
    let session = SessionMaterial::generate().expect("session");
    assert_ne!(session.csrf_token, session.session_token);
    let response = session.public_bootstrap();
    assert_eq!(
        serde_json::to_value(response).expect("serialize"),
        json!({
            "baseUrl": "http://127.0.0.1:3210/",
            "csrfToken": session.csrf_token.as_str(),
            "origin": "http://tauri.localhost",
            "sessionToken": session.session_token.as_str(),
        }),
    );
}

#[test]
fn bootstrap_is_unavailable_while_admission_processes_are_detached() {
    let supervisor = ControlRuntimeSupervisor {
        lifecycle: std::sync::Mutex::new(RuntimeLifecycle {
            available: true,
            control_api: None,
            control_generation: 2,
            worker: None,
            worker_generation: 2,
        }),
        reload: std::sync::Mutex::new(()),
        session: Some(SessionMaterial::generate().expect("session")),
    };

    assert!(matches!(
        supervisor.bootstrap(),
        Err("control_runtime_unavailable")
    ));
}

#[test]
fn generated_session_secrets_are_independent_bounded_hex() {
    let first = random_secret().expect("first secret");
    let second = random_secret().expect("second secret");
    assert_eq!(first.len(), 64);
    assert_eq!(second.len(), 64);
    assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert!(second.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert_ne!(first, second);
}

#[test]
fn provider_secret_is_a_zeroizing_child_environment_value() {
    let directory = tempdir().expect("temporary directory");
    let paths = super::RuntimePaths {
        artifact_database: directory.path().join("artifact.sqlite"),
        artifact_key: directory.path().join("artifact.key"),
        artifact_root: directory.path().join("artifacts"),
        control_api_bundle: directory.path().join("control.mjs"),
        control_database: directory.path().join("control.sqlite"),
        root: directory.path().to_path_buf(),
        runtime_release_bundle: directory.path().join("release.mjs"),
        worker_bundle: directory.path().join("worker.mjs"),
    };
    let runtime = ActiveProviderRuntime {
        binding: ActiveProviderBinding {
            credential_kind: ProviderCredentialKind::Keychain,
            endpoint: "https://api.example.com/v1".to_string(),
            environment_variable: None,
            provider_id: "gateway".to_string(),
        },
        secret: Some(Zeroizing::new("provider-secret".to_string())),
    };

    let environment = worker_environment(&paths, Some(&runtime));
    let credential = environment
        .iter()
        .find(|variable| variable.key == "CREWON_MODEL_API_KEY")
        .expect("credential environment");
    assert!(matches!(
        &credential.value,
        ChildEnvironmentValue::Sensitive(secret) if secret.as_str() == "provider-secret"
    ));
}

#[test]
fn readiness_consumes_the_exact_child_signal_without_sleeping() {
    let (sender, receiver) = mpsc::channel();
    sender
        .send(CommandEvent::Stdout(b"runtime ready\r\n".to_vec()))
        .expect("send readiness");
    assert_eq!(
        wait_for_ready(&receiver, b"runtime ready", Duration::from_secs(1)),
        Ok(()),
    );

    let (sender, receiver) = mpsc::channel();
    sender
        .send(CommandEvent::Terminated(TerminatedPayload {
            code: Some(1),
            signal: None,
        }))
        .expect("send termination");
    assert_eq!(
        wait_for_ready(&receiver, b"runtime ready", Duration::from_secs(1)),
        Err(()),
    );
}

#[test]
fn release_gate_requires_a_successful_process_exit_without_sleeping() {
    let (sender, receiver) = mpsc::channel();
    sender
        .send(CommandEvent::Stdout(b"bounded release summary".to_vec()))
        .expect("send output");
    sender
        .send(CommandEvent::Terminated(TerminatedPayload {
            code: Some(0),
            signal: None,
        }))
        .expect("send success");
    assert_eq!(
        wait_for_successful_exit(&receiver, Duration::from_secs(1)),
        Ok(()),
    );

    let (sender, receiver) = mpsc::channel();
    sender
        .send(CommandEvent::Terminated(TerminatedPayload {
            code: Some(1),
            signal: None,
        }))
        .expect("send failure");
    assert_eq!(
        wait_for_successful_exit(&receiver, Duration::from_secs(1)),
        Err(()),
    );
}

#[test]
fn provider_reload_gate_rejects_every_nonterminal_run_status() {
    let database = Connection::open_in_memory().expect("in-memory database");
    database
        .execute("CREATE TABLE run_snapshots (state_json TEXT NOT NULL)", [])
        .expect("run snapshots");

    for status in [
        "queued",
        "running",
        "waitingApproval",
        "suspended",
        "reconciling",
    ] {
        database
            .execute(
                "INSERT INTO run_snapshots (state_json) VALUES (json_object('status', ?1))",
                [status],
            )
            .expect("active run");
        assert_eq!(
            database
                .query_row(active_run_sql(), [], |_| Ok(()))
                .optional(),
            Ok(Some(())),
        );
        database
            .execute("DELETE FROM run_snapshots", [])
            .expect("clear active run");
    }

    for status in ["completed", "failed", "canceled"] {
        database
            .execute(
                "INSERT INTO run_snapshots (state_json) VALUES (json_object('status', ?1))",
                [status],
            )
            .expect("terminal run");
    }
    assert_eq!(
        database
            .query_row(active_run_sql(), [], |_| Ok(()))
            .optional(),
        Ok(None),
    );
}

#[test]
fn admission_fence_blocks_a_second_run_writer_without_sleeping() {
    let directory = tempdir().expect("temporary directory");
    let database_path = directory.path().join("control.sqlite");
    let mut fence = Connection::open(&database_path).expect("fence connection");
    fence
        .execute("CREATE TABLE run_snapshots (state_json TEXT NOT NULL)", [])
        .expect("run snapshots");
    let writer = Connection::open(&database_path).expect("admission writer");
    writer
        .busy_timeout(Duration::ZERO)
        .expect("zero busy timeout");

    let transaction = fence
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .expect("admission fence");
    let blocked = writer
        .execute(
            "INSERT INTO run_snapshots (state_json) VALUES (json_object('status', 'queued'))",
            [],
        )
        .expect_err("admission must not commit while the fence is held");
    assert!(matches!(
        blocked.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
    ));

    transaction.commit().expect("release admission fence");
    assert_eq!(
        writer.execute(
            "INSERT INTO run_snapshots (state_json) VALUES (json_object('status', 'queued'))",
            [],
        ),
        Ok(1),
    );
}
