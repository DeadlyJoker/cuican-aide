use std::cell::RefCell;
use std::path::Path;
use std::rc::Rc;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use pretty_assertions::assert_eq;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::TransactionBehavior;
use serde_json::json;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::process::TerminatedPayload;
use tempfile::tempdir;

use super::activate_release_before_worker;
use super::environment::control_environment;
use super::environment::release_environment;
use super::environment::worker_bootstrap_input;
use super::environment::worker_bootstrap_input_with_workspace;
use super::environment::worker_bootstrap_input_with_workspace_and_credentials;
use super::environment::worker_environment;
use super::environment::ChildEnvironmentValue;
use super::environment::ControlAdmissionMode;
use super::environment::WorkspaceWorkerEnvironment;
use super::private_credentials::PrivateCredentialBindings;
use super::process::spawn_managed;
use super::process::wait_for_bounded_json_exit;
use super::process::wait_for_ready;
use super::process::wait_for_successful_exit;
use super::process::ProcessRole;
use super::provider_switch::commit_provider_candidate;
use super::provider_switch::start_control_candidate;
use super::provider_switch::CandidateCommitFailure;
use super::random_secret;
use super::reload::active_run_sql;
use super::reload::admit_workspace_ready;
use super::reload::next_provider_generation_for_test;
use super::reload::with_resolved_runtime_private_credentials;
use super::reload::RuntimeGeneration;
use super::workspace_switch::resolve_workspace_private_credentials_before_switch;
use super::ControlRuntimeSupervisor;
use super::FailedProcessQuarantine;
use super::RuntimeLifecycle;
use super::SessionMaterial;
use crate::provider_credentials::ActiveProviderBinding;
use crate::provider_credentials::ActiveProviderRuntime;
use crate::provider_credentials::ProviderCredentialKind;
use crate::workspace_native::DesktopWorkspaceAuthorityManager;
use crate::workspace_native::RuntimeRouteProjection;
use zeroize::Zeroizing;

#[test]
fn bootstrap_serializes_the_exact_renderer_contract() {
    let session = SessionMaterial::generate().expect("session");
    assert_ne!(session.csrf_token, session.session_token);
    assert_ne!(session.csrf_token, session.provider_probe_token);
    assert_ne!(session.session_token, session.provider_probe_token);
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
        candidate_runtime: std::sync::Mutex::new(None),
        candidate_workspace: std::sync::Mutex::new(None),
        failed_admission_fence: std::sync::Mutex::new(None),
        failed_process_quarantine: std::sync::Mutex::new(FailedProcessQuarantine::default()),
        lifecycle: std::sync::Mutex::new(RuntimeLifecycle {
            available: true,
            candidate_failures: Vec::new(),
            control_api: None,
            control_generation: 2,
            device: None,
            device_generation: 0,
            gateway: None,
            gateway_generation: 0,
            worker: None,
            worker_generation: 2,
            workspace: None,
        }),
        reload: std::sync::Mutex::new(()),
        session: Some(SessionMaterial::generate().expect("session")),
        terminations: super::ProcessTerminationTracker::default(),
        workspace_authority_lease: None,
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
fn provider_secret_uses_zeroizing_stdin_bootstrap_not_child_environment() {
    let directory = tempdir().expect("temporary directory");
    let paths = runtime_paths(directory.path());
    let runtime = ActiveProviderRuntime {
        binding: ActiveProviderBinding {
            credential_kind: ProviderCredentialKind::Keychain,
            endpoint: "https://api.example.com/v1".to_string(),
            environment_variable: None,
            provider_id: "gateway".to_string(),
            runtime_binding_id: "desktop-supervisor:generation-1".to_string(),
        },
        secret: Some(Zeroizing::new("provider-secret".to_string())),
    };

    let environment = worker_environment(
        &paths,
        Some(&runtime),
        &RuntimeRouteProjection::standalone(),
    );
    assert!(environment
        .iter()
        .all(|variable| variable.key != "CREWON_MODEL_API_KEY"));
    let session = SessionMaterial::generate().expect("session");
    let control = control_environment(
        &paths,
        &session,
        None,
        &RuntimeRouteProjection::standalone(),
        ControlAdmissionMode::Active,
    );
    let private_probe_token = control
        .iter()
        .find(|variable| variable.key == "CREWON_PROVIDER_PROBE_WORKER_TOKEN")
        .expect("private Provider probe token");
    assert!(matches!(
        private_probe_token.value,
        ChildEnvironmentValue::Sensitive(_)
    ));
    let bootstrap = worker_bootstrap_input(Some(&runtime), &session).expect("worker bootstrap");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(bootstrap.as_ref()).expect("bootstrap json"),
        json!({
            "apiKey": "provider-secret",
            "provider": {
                "credentialKind": "keychain",
                "endpoint": "https://api.example.com/v1",
                "environmentVariable": null,
                "providerId": "gateway",
                "runtimeBindingId": "desktop-supervisor:generation-1",
            },
            "probe": {
                "port": 3211,
                "token": session.provider_probe_token.as_str(),
            },
            "schemaVersion": "crewon.worker-native-bootstrap.v1",
        }),
    );
}

#[test]
fn provider_changes_preserve_the_workspace_release_and_worker_route() {
    let directory = tempdir().expect("temporary directory");
    let paths = runtime_paths(directory.path());
    let workspace_path = directory.path().join("workspace");
    std::fs::create_dir(&workspace_path).expect("workspace directory");
    let mut manager = DesktopWorkspaceAuthorityManager::open(directory.path().join("authority"))
        .expect("workspace authority");
    manager
        .prepare("operation-select", 0, workspace_path)
        .expect("prepared workspace");
    manager
        .commit("operation-select")
        .expect("committed workspace");
    let route = RuntimeRouteProjection::from_authority(manager.authority())
        .expect("workspace runtime route");
    let runtime_generation = route.runtime_generation().to_string();
    let workspace_binding_id = route
        .workspace_binding_id()
        .expect("selected workspace binding")
        .to_string();
    let candidate = ActiveProviderRuntime {
        binding: ActiveProviderBinding {
            credential_kind: ProviderCredentialKind::None,
            endpoint: "https://candidate.example.com/v1".to_string(),
            environment_variable: None,
            provider_id: "candidate".to_string(),
            runtime_binding_id: "provider-runtime-2".to_string(),
        },
        secret: None,
    };
    let release = release_environment(&paths, Some(&candidate.binding), &route);
    let worker = worker_environment(&paths, Some(&candidate), &route);
    let session = SessionMaterial::generate().expect("session");
    let control = control_environment(&paths, &session, None, &route, ControlAdmissionMode::Active);
    let agent_version_id = route.agent_version_id().to_string();

    for environment in [&release, &worker] {
        let projected = environment
            .iter()
            .filter_map(|variable| {
                let key = variable.key.to_str()?;
                [
                    "CREWON_AGENT_VERSION_ID",
                    "CREWON_NATIVE_WORKSPACE_READ_ENABLED",
                    "CREWON_POLICY_SNAPSHOT_ID",
                    "CREWON_RUNTIME_GENERATION",
                    "CREWON_WORKSPACE_BINDING_ID",
                ]
                .contains(&key)
                .then(|| {
                    let ChildEnvironmentValue::Plain(value) = &variable.value else {
                        panic!("runtime route must not be secret environment");
                    };
                    (key.to_string(), value.to_string_lossy().into_owned())
                })
            })
            .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(
            projected,
            std::collections::BTreeMap::from([
                (
                    "CREWON_AGENT_VERSION_ID".to_string(),
                    agent_version_id.clone(),
                ),
                (
                    "CREWON_NATIVE_WORKSPACE_READ_ENABLED".to_string(),
                    "1".to_string(),
                ),
                (
                    "CREWON_POLICY_SNAPSHOT_ID".to_string(),
                    "standalone-policy-v0".to_string(),
                ),
                (
                    "CREWON_RUNTIME_GENERATION".to_string(),
                    runtime_generation.clone(),
                ),
                (
                    "CREWON_WORKSPACE_BINDING_ID".to_string(),
                    workspace_binding_id.clone(),
                ),
            ])
        );
    }
    assert!(control.iter().any(|variable| {
        variable.key == "CREWON_AGENT_VERSION_ID"
            && matches!(
                &variable.value,
                ChildEnvironmentValue::Plain(value) if value == agent_version_id.as_str()
            )
    }));
}

#[test]
fn standalone_release_and_worker_omit_native_workspace_read_enablement() {
    let directory = tempdir().expect("temporary directory");
    let paths = runtime_paths(directory.path());
    let route = RuntimeRouteProjection::standalone();
    let release = release_environment(&paths, None, &route);
    let worker = worker_environment(&paths, None, &route);

    for environment in [&release, &worker] {
        assert!(environment.iter().all(|variable| {
            variable.key != "CREWON_NATIVE_WORKSPACE_READ_ENABLED"
                && variable.key != "CREWON_WORKSPACE_BINDING_ID"
        }));
    }
}

#[test]
fn candidate_release_activation_precedes_worker_start_and_fails_closed() {
    let trace = Rc::new(RefCell::new(Vec::new()));
    let activation_trace = Rc::clone(&trace);
    let worker_trace = Rc::clone(&trace);
    let worker = activate_release_before_worker(
        move || {
            activation_trace.borrow_mut().push("release");
            Ok::<(), &str>(())
        },
        move || {
            worker_trace.borrow_mut().push("worker");
            Ok("candidate-worker")
        },
    );
    assert_eq!(worker, Ok("candidate-worker"));
    assert_eq!(trace.borrow().as_slice(), ["release", "worker"]);

    let started = Rc::new(RefCell::new(false));
    let started_worker = Rc::clone(&started);
    let failed = activate_release_before_worker(
        || Err::<(), _>("release-failed"),
        move || {
            *started_worker.borrow_mut() = true;
            Ok("candidate-worker")
        },
    );
    assert_eq!(failed, Err("release-failed"));
    assert_eq!(*started.borrow(), false);
}

#[test]
fn private_credentials_resolve_once_before_detach_and_are_reused_for_rollback() {
    let trace = Rc::new(RefCell::new(Vec::new()));
    let resolve_trace = Rc::clone(&trace);
    let transition_trace = Rc::clone(&trace);
    let missing = with_resolved_runtime_private_credentials(
        move || {
            resolve_trace.borrow_mut().push("resolve-missing");
            Err::<String, _>("credential-missing")
        },
        move |_| {
            transition_trace.borrow_mut().push("detach");
            transition_trace.borrow_mut().push("activate");
            Ok(())
        },
    );
    assert_eq!(missing, Err("credential-missing"));
    assert_eq!(trace.borrow().as_slice(), ["resolve-missing"]);

    trace.borrow_mut().clear();
    let resolve_trace = Rc::clone(&trace);
    let transition_trace = Rc::clone(&trace);
    let candidate_failure = with_resolved_runtime_private_credentials(
        move || {
            resolve_trace.borrow_mut().push("resolve");
            Ok::<_, &str>(Zeroizing::new("one-read-secret".to_string()))
        },
        move |credentials| {
            let candidate_pointer = credentials.as_ptr();
            transition_trace.borrow_mut().push("detach");
            transition_trace.borrow_mut().push("activate-candidate");
            transition_trace.borrow_mut().push("candidate-failed");
            assert_eq!(credentials.as_ptr(), candidate_pointer);
            transition_trace.borrow_mut().push("activate-rollback");
            Err::<(), _>("candidate-failed")
        },
    );
    assert_eq!(candidate_failure, Err("candidate-failed"));
    assert_eq!(
        trace.borrow().as_slice(),
        [
            "resolve",
            "detach",
            "activate-candidate",
            "candidate-failed",
            "activate-rollback",
        ]
    );
}

#[test]
fn workspace_switch_preparses_both_manifests_before_runtime_transition() {
    let trace = Rc::new(RefCell::new(Vec::new()));
    let old_trace = Rc::clone(&trace);
    let candidate_trace = Rc::clone(&trace);
    let result = resolve_workspace_private_credentials_before_switch(
        move || {
            old_trace.borrow_mut().push("old-manifest");
            Ok::<_, &str>("old-credentials")
        },
        move || {
            candidate_trace
                .borrow_mut()
                .push("candidate-manifest-invalid");
            Err("binding-invalid")
        },
    );
    assert_eq!(result, Err("binding-invalid"));
    assert_eq!(
        trace.borrow().as_slice(),
        ["old-manifest", "candidate-manifest-invalid"]
    );
}

#[test]
fn workspace_worker_uses_v2_stdin_and_control_gets_only_the_proven_loopback_route() {
    let directory = tempdir().expect("temporary directory");
    let paths = runtime_paths(directory.path());
    let session = SessionMaterial::generate().expect("session");
    let workspace = json!({
        "authority": { "runtimeBindingId": "workspace-runtime-1" },
        "gateway": { "endpoint": "https://127.0.0.1:43125" },
        "privateServer": { "port": 0, "token": "workspace-private-token-0000000001" },
        "signing": { "keyId": "workspace-key-1" },
    });
    let workspace_json = serde_json::to_vec(&workspace).expect("workspace json");
    let bootstrap = worker_bootstrap_input_with_workspace(None, &session, &workspace_json)
        .expect("v2 bootstrap");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&bootstrap).expect("bootstrap json"),
        json!({
            "apiKey": null,
            "provider": null,
            "probe": {
                "port": 3211,
                "token": session.provider_probe_token.as_str(),
            },
            "schemaVersion": "crewon.worker-native-bootstrap.v2",
            "workspace": workspace,
        })
    );

    let control = control_environment(
        &paths,
        &session,
        Some(&WorkspaceWorkerEnvironment {
            origin: "http://127.0.0.1:43126",
            token: "workspace-private-token-0000000001",
            deadline_ms: 40_000,
        }),
        &RuntimeRouteProjection::standalone(),
        ControlAdmissionMode::Active,
    );
    assert!(control.iter().any(|variable| {
        variable.key == "CREWON_WORKSPACE_WORKER_ORIGIN"
            && matches!(
                &variable.value,
                ChildEnvironmentValue::Plain(value)
                    if value == "http://127.0.0.1:43126"
            )
    }));
    assert!(control.iter().any(|variable| {
        variable.key == "CREWON_WORKSPACE_WORKER_TOKEN"
            && matches!(variable.value, ChildEnvironmentValue::Sensitive(_))
    }));
}

#[test]
fn remote_mcp_credentials_use_exact_v3_zeroizing_stdin_without_legacy_wire_changes() {
    let session = SessionMaterial::generate().expect("session");
    let workspace_json =
        serde_json::to_vec(&json!({ "workspace": "private" })).expect("workspace json");
    let credentials = PrivateCredentialBindings::new(
        "tenant-1".to_string(),
        "workspace-1".to_string(),
        "runtime-1".to_string(),
        "agent-version-1".to_string(),
        vec![(
            "credential-1".to_string(),
            Zeroizing::new("private+/bearer==".to_string()),
        )],
    )
    .expect("credential bindings");
    let bootstrap = worker_bootstrap_input_with_workspace_and_credentials(
        None,
        &session,
        &workspace_json,
        Some(&credentials),
    )
    .expect("v3 bootstrap");
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&bootstrap).expect("bootstrap json"),
        json!({
            "apiKey": null,
            "credentialBindings": {
                "schemaVersion": "crewon.remote-mcp-private-credentials.v1",
                "authority": {
                    "tenantId": "tenant-1",
                    "workspaceBindingId": "workspace-1",
                    "runtimeBindingId": "runtime-1",
                    "agentVersionId": "agent-version-1",
                },
                "bindings": [{
                    "credentialBindingId": "credential-1",
                    "bearerToken": "private+/bearer==",
                }],
            },
            "probe": {
                "port": 3211,
                "token": session.provider_probe_token.as_str(),
            },
            "provider": null,
            "schemaVersion": "crewon.worker-native-bootstrap.v3",
            "workspace": { "workspace": "private" },
        })
    );
    assert_eq!(
        format!("{credentials:?}"),
        "PrivateCredentialBindings([REDACTED])"
    );

    let legacy = worker_bootstrap_input_with_workspace(None, &session, &workspace_json)
        .expect("legacy v2 bootstrap");
    let legacy: serde_json::Value = serde_json::from_slice(&legacy).expect("legacy json");
    assert_eq!(legacy["schemaVersion"], "crewon.worker-native-bootstrap.v2");
    assert_eq!(legacy.get("credentialBindings"), None);
}

#[test]
fn private_credential_bindings_reject_empty_duplicate_and_invalid_shapes() {
    let token = || Zeroizing::new("private+/bearer==".to_string());
    assert!(PrivateCredentialBindings::new(
        "tenant-1".to_string(),
        "workspace-1".to_string(),
        "runtime-1".to_string(),
        "agent-version-1".to_string(),
        vec![],
    )
    .is_err());
    assert!(PrivateCredentialBindings::new(
        "tenant-1".to_string(),
        "workspace-1".to_string(),
        "runtime-1".to_string(),
        "agent-version-1".to_string(),
        vec![
            ("credential-1".to_string(), token()),
            ("credential-1".to_string(), token()),
        ],
    )
    .is_err());
    assert!(PrivateCredentialBindings::new(
        "tenant-1".to_string(),
        "workspace-1".to_string(),
        "runtime-1".to_string(),
        "agent-version-1".to_string(),
        vec![(
            "credential-1".to_string(),
            Zeroizing::new("has space".to_string())
        )],
    )
    .is_err());
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

    let (sender, receiver) = mpsc::channel();
    sender
        .send(CommandEvent::Stdout(
            b"CrewON Provider Runtime ready:old-binding\n".to_vec(),
        ))
        .expect("send stale provider readiness");
    sender
        .send(CommandEvent::Terminated(TerminatedPayload {
            code: Some(0),
            signal: None,
        }))
        .expect("terminate stale Worker");
    assert_eq!(
        wait_for_ready(
            &receiver,
            b"CrewON Provider Runtime ready:candidate-binding",
            Duration::from_secs(1),
        ),
        Err(()),
    );
}

#[test]
fn coordinator_output_is_bounded_and_requires_successful_exit() {
    let (sender, receiver) = mpsc::channel();
    sender
        .send(CommandEvent::Stdout(b"{\"phase\":".to_vec()))
        .expect("send first chunk");
    sender
        .send(CommandEvent::Stdout(b"\"inspect\"}\n".to_vec()))
        .expect("send second chunk");
    sender
        .send(CommandEvent::Terminated(TerminatedPayload {
            code: Some(0),
            signal: None,
        }))
        .expect("send successful exit");
    assert_eq!(
        wait_for_bounded_json_exit(&receiver, Duration::from_secs(1), 64),
        Ok(b"{\"phase\":\"inspect\"}".to_vec()),
    );

    let (sender, receiver) = mpsc::channel();
    sender
        .send(CommandEvent::Stdout(vec![b'x'; 65]))
        .expect("send oversized output");
    assert_eq!(
        wait_for_bounded_json_exit(&receiver, Duration::from_secs(1), 64),
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

#[test]
fn termination_latch_holds_the_admission_fence_until_both_exact_children_exit() {
    let directory = tempdir().expect("temporary directory");
    let database_path = directory.path().join("control.sqlite");
    Connection::open(&database_path)
        .expect("create database")
        .execute("CREATE TABLE admission (value INTEGER NOT NULL)", [])
        .expect("admission table");
    let tracker = Arc::new(super::ProcessTerminationTracker::default());
    let expected = vec![ProcessRole::ControlApi(7), ProcessRole::Worker(11)];
    tracker
        .begin(expected.clone())
        .expect("begin exact termination wait");
    let (fence_ready_tx, fence_ready_rx) = mpsc::channel();
    let (fence_released_tx, fence_released_rx) = mpsc::channel();
    let fence_tracker = Arc::clone(&tracker);
    let fence_path = database_path.clone();
    let fence_expected = expected.clone();
    let fence = std::thread::spawn(move || {
        let database = Connection::open(fence_path).expect("fence database");
        database
            .execute_batch("BEGIN IMMEDIATE")
            .expect("begin admission fence");
        fence_ready_tx.send(()).expect("publish fence");
        assert!(fence_tracker.wait(&fence_expected, Duration::from_secs(1)));
        database.execute_batch("COMMIT").expect("commit fence");
        fence_tracker.finish(&fence_expected);
        fence_released_tx.send(()).expect("publish release");
    });
    fence_ready_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("fence ready");
    let writer = Connection::open(&database_path).expect("admission writer");
    writer
        .busy_timeout(Duration::ZERO)
        .expect("zero busy timeout");

    assert_writer_blocked(&writer);
    assert!(!tracker.acknowledge(ProcessRole::ControlApi(6)));
    assert_writer_blocked(&writer);
    assert!(!tracker.acknowledge(expected[0]));
    assert_writer_blocked(&writer);
    assert!(tracker.acknowledge(expected[1]));
    fence_released_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("fence released");
    assert_eq!(
        writer.execute("INSERT INTO admission VALUES (1)", []),
        Ok(1)
    );
    fence.join().expect("fence thread");
}

#[test]
fn failed_stop_retains_the_fence_until_late_exact_termination_acknowledgements() {
    let directory = tempdir().expect("temporary directory");
    let database_path = directory.path().join("control.sqlite");
    let database = Connection::open(&database_path).expect("fence database");
    database
        .execute("CREATE TABLE admission (value INTEGER NOT NULL)", [])
        .expect("admission table");
    database
        .execute_batch("BEGIN IMMEDIATE")
        .expect("begin failed admission fence");
    let supervisor = ControlRuntimeSupervisor::unavailable();
    let expected = vec![ProcessRole::ControlApi(3), ProcessRole::Worker(5)];
    supervisor
        .terminations
        .begin(expected.clone())
        .expect("begin exact termination wait");
    supervisor.retain_failed_admission_fence_with_processes(database, expected.clone(), Vec::new());
    let writer = Connection::open(&database_path).expect("admission writer");
    writer
        .busy_timeout(Duration::ZERO)
        .expect("zero busy timeout");

    assert_writer_blocked(&writer);
    supervisor.process_terminated(expected[0], false);
    assert_writer_blocked(&writer);
    supervisor.process_terminated(expected[0], true);
    assert_writer_blocked(&writer);
    supervisor.process_terminated(ProcessRole::Worker(4), true);
    assert_writer_blocked(&writer);
    supervisor.process_terminated(expected[1], true);
    assert_eq!(
        writer.execute("INSERT INTO admission VALUES (1)", []),
        Ok(1)
    );
}

#[test]
fn control_readiness_failure_stops_the_candidate_worker_before_recovery() {
    let trace = Rc::new(RefCell::new(Vec::new()));
    let start_trace = Rc::clone(&trace);
    let stop_trace = Rc::clone(&trace);
    let result = start_control_candidate(
        "candidate-worker",
        move |worker| {
            assert_eq!(*worker, "candidate-worker");
            start_trace.borrow_mut().push("control-ready");
            Err::<&str, _>("control-not-ready")
        },
        move |worker| {
            assert_eq!(worker, "candidate-worker");
            stop_trace.borrow_mut().push("worker-stopped");
        },
    );

    assert_eq!(result, Err("control-not-ready"));
    assert_eq!(
        trace.borrow().as_slice(),
        ["control-ready", "worker-stopped"]
    );
}

#[test]
fn missing_or_mismatched_workspace_readiness_stops_the_unowned_candidate_worker() {
    for failure in ["workspace-ready-missing", "workspace-binding-mismatch"] {
        let stopped = Rc::new(RefCell::new(Vec::new()));
        let stop_trace = Rc::clone(&stopped);
        let result = admit_workspace_ready(
            "candidate-worker",
            || Err::<(), _>(failure),
            move |worker| stop_trace.borrow_mut().push(worker),
        );
        assert_eq!(result, Err(failure));
        assert_eq!(stopped.borrow().as_slice(), ["candidate-worker"]);
    }
}

#[test]
fn provider_reload_advances_only_worker_and_control_generations() {
    let lifecycle = RuntimeLifecycle {
        available: true,
        candidate_failures: Vec::new(),
        control_generation: 7,
        control_api: None,
        device: None,
        device_generation: 3,
        gateway: None,
        gateway_generation: 3,
        worker: None,
        worker_generation: 11,
        workspace: None,
    };
    assert_eq!(
        next_provider_generation_for_test(&lifecycle).expect("next Provider generation"),
        RuntimeGeneration {
            control: 8,
            device: 3,
            gateway: 3,
            worker: 12,
        }
    );
}

#[cfg(unix)]
#[test]
fn candidate_quarantine_blocks_switch_without_disabling_the_healthy_old_runtime() {
    let supervisor = quarantine_supervisor();
    supervisor.quarantine_processes_with_terminator(
        vec![running_quarantine_child("candidate-quarantine")],
        false,
        |_| false,
    );
    assert!(supervisor.lifecycle.lock().unwrap().available);
    let quarantine = supervisor.failed_process_quarantine.lock().unwrap();
    assert_eq!(quarantine.disables_runtime, false);
    assert_eq!(quarantine.processes.len(), 1);
    drop(quarantine);
    supervisor.shutdown();
}

#[cfg(unix)]
#[test]
fn active_quarantine_marks_the_runtime_unavailable_and_retains_exact_ownership() {
    let supervisor = quarantine_supervisor();
    supervisor.quarantine_processes_with_terminator(
        vec![running_quarantine_child("active-quarantine")],
        true,
        |_| false,
    );
    assert_eq!(supervisor.lifecycle.lock().unwrap().available, false);
    let quarantine = supervisor.failed_process_quarantine.lock().unwrap();
    assert_eq!(quarantine.disables_runtime, true);
    assert_eq!(quarantine.processes.len(), 1);
    drop(quarantine);
    supervisor.shutdown();
}

#[cfg(unix)]
fn quarantine_supervisor() -> ControlRuntimeSupervisor {
    ControlRuntimeSupervisor::started(
        SessionMaterial::generate().unwrap(),
        running_quarantine_child("quarantine-control"),
        running_quarantine_child("quarantine-worker"),
        None,
        None,
    )
}

#[cfg(unix)]
fn running_quarantine_child(name: &'static str) -> super::process::ManagedChild {
    let mut command = std::process::Command::new("/bin/sh");
    command.arg("-c").arg("exec /bin/cat");
    spawn_managed(command, name).unwrap().1
}

#[test]
fn provider_candidate_finalizes_only_after_readiness_and_stops_every_failed_candidate() {
    assert_eq!(
        candidate_commit_trace(CandidateCommitScenario::FinalizeFailure),
        vec!["finalize", "stop"]
    );
    assert_eq!(
        candidate_commit_trace(CandidateCommitScenario::InvalidFinalization),
        vec!["finalize", "validate", "stop"]
    );
    assert_eq!(
        candidate_commit_trace(CandidateCommitScenario::InstallFailure),
        vec!["finalize", "validate", "install", "stop"]
    );
    assert_eq!(
        candidate_commit_trace(CandidateCommitScenario::Committed),
        vec!["finalize", "validate", "install"]
    );
}

#[derive(Clone, Copy)]
enum CandidateCommitScenario {
    FinalizeFailure,
    InvalidFinalization,
    InstallFailure,
    Committed,
}

fn candidate_commit_trace(scenario: CandidateCommitScenario) -> Vec<&'static str> {
    let trace = Rc::new(RefCell::new(Vec::new()));
    let finalize_trace = Rc::clone(&trace);
    let validate_trace = Rc::clone(&trace);
    let install_trace = Rc::clone(&trace);
    let stop_trace = Rc::clone(&trace);
    let outcome = commit_provider_candidate(
        "candidate",
        move || {
            finalize_trace.borrow_mut().push("finalize");
            if matches!(scenario, CandidateCommitScenario::FinalizeFailure) {
                Err("finalize-failed")
            } else {
                Ok("finalized")
            }
        },
        move |finalized| {
            assert_eq!(*finalized, "finalized");
            validate_trace.borrow_mut().push("validate");
            !matches!(scenario, CandidateCommitScenario::InvalidFinalization)
        },
        move |candidate| {
            assert_eq!(candidate, "candidate");
            install_trace.borrow_mut().push("install");
            if matches!(scenario, CandidateCommitScenario::InstallFailure) {
                Err(("install-failed", candidate))
            } else {
                Ok(())
            }
        },
        move |candidate| {
            assert_eq!(candidate, "candidate");
            stop_trace.borrow_mut().push("stop");
        },
    );
    match scenario {
        CandidateCommitScenario::FinalizeFailure => {
            assert!(matches!(
                outcome,
                Err(CandidateCommitFailure::BeforeFinalize("finalize-failed"))
            ));
        }
        CandidateCommitScenario::InvalidFinalization => {
            assert!(matches!(
                outcome,
                Err(CandidateCommitFailure::FinalizedAuthorityInvalid)
            ));
        }
        CandidateCommitScenario::InstallFailure => {
            assert!(matches!(
                outcome,
                Err(CandidateCommitFailure::Install("install-failed"))
            ));
        }
        CandidateCommitScenario::Committed => assert!(outcome.is_ok()),
    }
    Rc::try_unwrap(trace)
        .expect("all trace owners dropped")
        .into_inner()
}

fn assert_writer_blocked(writer: &Connection) {
    let blocked = writer
        .execute("INSERT INTO admission VALUES (1)", [])
        .expect_err("writer must remain blocked by the admission fence");
    assert!(matches!(
        blocked.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
    ));
}

fn runtime_paths(root: &Path) -> super::RuntimePaths {
    super::RuntimePaths {
        artifact_database: root.join("artifact.sqlite"),
        artifact_key: root.join("artifact.key"),
        artifact_root: root.join("artifacts"),
        control_api_bundle: root.join("control.mjs"),
        control_database: root.join("control.sqlite"),
        device_gateway_bundle: root.join("gateway.mjs"),
        provider_coordinator_bundle: root.join("coordinator.mjs"),
        root: root.to_path_buf(),
        runtime_release_bundle: root.join("release.mjs"),
        worker_bundle: root.join("worker.mjs"),
        workspace_authority: root.join("workspace-authority"),
        workspace_launch_root: root.join("workspace-launch"),
        workspace_runtime_root: root.join("workspace-runtimes"),
    }
}
