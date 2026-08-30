use std::fs;
use std::sync::Arc;
use std::sync::Barrier;
use std::sync::atomic::AtomicU32;
use std::sync::atomic::Ordering;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chrono::DateTime;
use chrono::Duration;
use chrono::Utc;
use crewon_device_journal::DeviceWorkspaceJournal;
use crewon_device_journal::ToolJournalListQuery;
use crewon_device_protocol::DeviceCompletedData;
use crewon_device_protocol::DeviceExecutionCommand;
use crewon_device_protocol::DeviceExecutionEvent;
use crewon_device_protocol::DeviceGatewayWelcome;
use crewon_device_protocol::canonical_device_command_signing_payload;
use crewon_device_protocol::parse_device_execution_command;
use crewon_device_protocol::parse_device_gateway_welcome;
use ed25519_dalek::Signer as _;
use ed25519_dalek::SigningKey;
use ed25519_dalek::pkcs8::EncodePublicKey as _;
use ed25519_dalek::pkcs8::spki::der::pem::LineEnding;
use pretty_assertions::assert_eq;
use serde::Deserialize;
use serde_json::Value;
use tempfile::TempDir;

use super::NativeToolDispatchOutcome;
use super::NativeToolExecutor;
use super::NativeToolOrchestrator;
use crate::ConnectionEpochFence;
use crate::DeviceCommandAuthorizer;
use crate::NativeDeviceConnection;
use crate::TrustedDeviceCommandKey;
use crate::WorkspaceListCancellation;
use crate::native_tool_events::accepted;

#[derive(Deserialize)]
struct Reference {
    valid: ValidReference,
}
#[derive(Deserialize)]
struct ValidReference {
    command: Value,
    welcome: Value,
}

#[tokio::test]
async fn takeover_after_durable_acceptance_yields_unknown_without_execution() {
    let fixture = fixture();
    let directory = TempDir::new().expect("state");
    let fence =
        ConnectionEpochFence::open("device-1", directory.path().join("epoch")).expect("fence");
    let authorizer = authorizer(&fixture.key);
    let connection = establish(&fence, &authorizer, &fixture.welcome);
    let journal = DeviceWorkspaceJournal::open(directory.path().join("journal.sqlite"))
        .await
        .expect("journal");
    let orchestrator =
        NativeToolOrchestrator::with_clock(journal, || timestamp("2026-08-08T00:00:04Z"));
    let acquisitions = AtomicU32::new(0);
    let executions = AtomicU32::new(0);
    let executor = FakeExecutor {
        acquisitions: &acquisitions,
        executions: &executions,
        execution_barriers: None,
    };
    let mut newer = fixture.welcome.clone();
    newer.connection_epoch += 1;
    newer.connection_id = "connection-new".to_string();
    let outcome = orchestrator
        .dispatch(
            &connection,
            &serde_json::to_vec(&fixture.command).expect("command"),
            &executor,
            &WorkspaceListCancellation::default(),
            |_| {
                assert_eq!(acquisitions.load(Ordering::SeqCst), 0);
                establish(&fence, &authorizer, &newer);
            },
        )
        .await
        .expect("dispatch");
    let NativeToolDispatchOutcome::FreshResolved { terminal, .. } = outcome else {
        panic!("fresh outcome");
    };
    assert!(matches!(
        terminal,
        DeviceExecutionEvent::UnknownOutcome { .. }
    ));
    assert_eq!(acquisitions.load(Ordering::SeqCst), 1);
    assert_eq!(executions.load(Ordering::SeqCst), 0);
}

#[test]
fn blocked_execution_allows_takeover_and_old_completion_becomes_unknown() {
    let fixture = fixture();
    let directory = TempDir::new().expect("state");
    let fence =
        ConnectionEpochFence::open("device-1", directory.path().join("epoch")).expect("fence");
    let authorizer = authorizer(&fixture.key);
    let connection = establish(&fence, &authorizer, &fixture.welcome);
    let journal = tokio::runtime::Runtime::new()
        .expect("runtime")
        .block_on(DeviceWorkspaceJournal::open(
            directory.path().join("journal.sqlite"),
        ))
        .expect("journal");
    let orchestrator =
        NativeToolOrchestrator::with_clock(journal, || timestamp("2026-08-08T00:00:04Z"));
    let acquisitions = AtomicU32::new(0);
    let executions = AtomicU32::new(0);
    let started = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let executor = FakeExecutor {
        acquisitions: &acquisitions,
        executions: &executions,
        execution_barriers: Some((Arc::clone(&started), Arc::clone(&release))),
    };
    let frame = serde_json::to_vec(&fixture.command).expect("command");
    let cancellation = WorkspaceListCancellation::default();
    std::thread::scope(|scope| {
        let dispatch = scope.spawn(|| {
            tokio::runtime::Runtime::new()
                .expect("dispatch runtime")
                .block_on(orchestrator.dispatch(
                    &connection,
                    &frame,
                    &executor,
                    &cancellation,
                    |_| {},
                ))
                .expect("dispatch")
        });
        started.wait();
        let mut newer = fixture.welcome.clone();
        newer.connection_epoch += 1;
        newer.connection_id = "connection-new".to_string();
        establish(&fence, &authorizer, &newer);
        release.wait();
        let NativeToolDispatchOutcome::FreshResolved { terminal, .. } =
            dispatch.join().expect("dispatch thread")
        else {
            panic!("fresh outcome");
        };
        assert!(matches!(
            terminal,
            DeviceExecutionEvent::UnknownOutcome { .. }
        ));
    });
    assert_eq!(acquisitions.load(Ordering::SeqCst), 1);
    assert_eq!(executions.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn accepted_only_restart_records_unknown_and_never_calls_executor() {
    let fixture = fixture();
    let directory = TempDir::new().expect("state");
    let path = directory.path().join("journal.sqlite");
    let journal = DeviceWorkspaceJournal::open(&path).await.expect("journal");
    let accepted = accepted(&fixture.command, timestamp("2026-08-08T00:00:03Z"));
    journal
        .prepare_tool_with_admission(&fixture.command, || Ok::<_, ()>((accepted, ())))
        .await
        .expect("accepted");
    journal.close().await;
    let reopened = DeviceWorkspaceJournal::open(&path).await.expect("reopen");
    let orchestrator =
        NativeToolOrchestrator::with_clock(reopened, || timestamp("2026-08-08T00:00:04Z"));
    let items = orchestrator
        .reconnect(&ToolJournalListQuery {
            after_execution_id: None,
            limit: 10,
        })
        .await
        .expect("reconnect");
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].events.len(), 2);
    assert!(matches!(
        items[0].events[1],
        DeviceExecutionEvent::UnknownOutcome { .. }
    ));
}

struct FakeExecutor<'a> {
    acquisitions: &'a AtomicU32,
    executions: &'a AtomicU32,
    execution_barriers: Option<(Arc<Barrier>, Arc<Barrier>)>,
}
impl NativeToolExecutor for FakeExecutor<'_> {
    type Metadata = DeviceExecutionCommand;
    type Acquired<'a>
        = DeviceExecutionCommand
    where
        Self: 'a;
    fn advertised_capabilities(&self) -> &'static [&'static str] {
        &["workspace.read"]
    }
    fn admit_metadata(
        &self,
        connection: &NativeDeviceConnection<'_>,
        frame: &[u8],
        now: DateTime<Utc>,
    ) -> Result<(DeviceExecutionCommand, Self::Metadata), crate::NativeDeviceAdmissionError> {
        let verified = connection.verify_command(frame, now)?;
        let command = verified.command().clone();
        Ok((command.clone(), command))
    }
    fn acquire<'a>(
        &'a self,
        connection: &NativeDeviceConnection<'_>,
        metadata: &Self::Metadata,
        now: DateTime<Utc>,
        _cancellation: &WorkspaceListCancellation,
    ) -> Result<Self::Acquired<'a>, crate::NativeDeviceAdmissionError> {
        self.acquisitions.fetch_add(1, Ordering::SeqCst);
        let frame = serde_json::to_vec(metadata).expect("metadata command");
        let verified = connection.verify_command(&frame, now)?;
        connection.start_command(verified, now, |_| metadata.clone())
    }
    fn execute<'a>(
        &'a self,
        _acquired: Self::Acquired<'a>,
        _cancellation: &WorkspaceListCancellation,
    ) -> Result<DeviceCompletedData, crate::NativeDeviceAdmissionError> {
        self.executions.fetch_add(1, Ordering::SeqCst);
        if let Some((started, release)) = &self.execution_barriers {
            started.wait();
            release.wait();
        }
        Ok(DeviceCompletedData {
            output: None,
            artifact_ref: None,
            output_digest: digest('0'),
            stdout_digest: digest('0'),
            stderr_digest: digest('0'),
            exit_code: None,
            exit_signal: None,
        })
    }
    fn validate_continuation(
        &self,
        connection: &NativeDeviceConnection<'_>,
        metadata: &Self::Metadata,
        now: DateTime<Utc>,
    ) -> Result<(), crate::NativeDeviceAdmissionError> {
        let frame = serde_json::to_vec(metadata).expect("metadata command");
        let verified = connection.verify_command(&frame, now)?;
        connection.start_command(verified, now, |_| ())
    }
}

struct Fixture {
    command: DeviceExecutionCommand,
    welcome: DeviceGatewayWelcome,
    key: SigningKey,
}
fn fixture() -> Fixture {
    let path = crewon_utils_cargo_bin::find_resource!(
        "../../packages/test-contracts/fixtures/device-protocol.reference.json"
    )
    .expect("fixture");
    let reference: Reference =
        serde_json::from_str(&fs::read_to_string(path).expect("read")).expect("parse");
    let key = SigningKey::from_bytes(&[7; 32]);
    let mut command = parse_device_execution_command(reference.valid.command).expect("command");
    command.authorization.signature = URL_SAFE_NO_PAD.encode(
        key.sign(
            canonical_device_command_signing_payload(&command)
                .expect("payload")
                .as_bytes(),
        )
        .to_bytes(),
    );
    Fixture {
        command,
        welcome: parse_device_gateway_welcome(reference.valid.welcome).expect("welcome"),
        key,
    }
}
fn authorizer(key: &SigningKey) -> DeviceCommandAuthorizer {
    DeviceCommandAuthorizer::new(
        [TrustedDeviceCommandKey {
            key_id: "control-key-1".to_string(),
            public_key_pem: key
                .verifying_key()
                .to_public_key_pem(LineEnding::LF)
                .expect("pem"),
        }],
        Duration::minutes(5),
    )
    .expect("authorizer")
}
fn establish<'a>(
    fence: &'a ConnectionEpochFence,
    authorizer: &'a DeviceCommandAuthorizer,
    welcome: &DeviceGatewayWelcome,
) -> NativeDeviceConnection<'a> {
    NativeDeviceConnection::establish(
        fence,
        authorizer,
        &serde_json::to_vec(welcome).expect("welcome"),
        timestamp("2026-08-08T00:00:03Z"),
    )
    .expect("establish")
}
fn timestamp(value: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(value)
        .expect("timestamp")
        .with_timezone(&Utc)
}
fn digest(value: char) -> String {
    format!("sha256:{}", value.to_string().repeat(64))
}
