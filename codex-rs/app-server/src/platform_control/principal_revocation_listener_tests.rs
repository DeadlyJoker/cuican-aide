use std::collections::VecDeque;
use std::sync::Mutex;

use crewon_app_server_transport::TransportPrincipalRevocationRegistry;
use crewon_provider_agent_platform::PrincipalRevocation;
use crewon_provider_agent_platform::PrincipalRevocationCursor;
use crewon_provider_agent_platform::PrincipalRevocationCursorSpec;
use crewon_provider_agent_platform::PrincipalRevocationReadPage;
use crewon_provider_agent_platform::PrincipalRevocationSnapshotPage;
use crewon_provider_agent_platform::PrincipalRevocationSpec;
use pretty_assertions::assert_eq;
use tokio_util::sync::CancellationToken;

use super::principal_revocation_listener::PrincipalRevocationFeed;
use super::principal_revocation_listener::PrincipalRevocationFeedError;
use super::principal_revocation_listener::PrincipalRevocationListener;
use super::principal_revocation_listener::PrincipalRevocationListenerError;
use super::principal_revocation_listener::PrincipalRevocationListenerSettings;

const STREAM_ID: &str = "019f7000-0000-7000-8000-000000000001";
const OTHER_STREAM_ID: &str = "019f7000-0000-7000-8000-000000000002";

#[derive(Debug, Clone, PartialEq, Eq)]
struct SnapshotCall {
    after_sequence: u64,
    watermark_sequence: Option<u64>,
    limit: u32,
    now: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ReadCall {
    stream_id: String,
    sequence: u64,
    limit: u32,
    now: i64,
}

struct FakeFeed {
    snapshots:
        Mutex<VecDeque<Result<PrincipalRevocationSnapshotPage, PrincipalRevocationFeedError>>>,
    reads: Mutex<VecDeque<Result<PrincipalRevocationReadPage, PrincipalRevocationFeedError>>>,
    snapshot_calls: Mutex<Vec<SnapshotCall>>,
    read_calls: Mutex<Vec<ReadCall>>,
}

impl FakeFeed {
    fn new(
        snapshots: Vec<Result<PrincipalRevocationSnapshotPage, PrincipalRevocationFeedError>>,
        reads: Vec<Result<PrincipalRevocationReadPage, PrincipalRevocationFeedError>>,
    ) -> Self {
        Self {
            snapshots: Mutex::new(snapshots.into()),
            reads: Mutex::new(reads.into()),
            snapshot_calls: Mutex::new(Vec::new()),
            read_calls: Mutex::new(Vec::new()),
        }
    }
}

impl PrincipalRevocationFeed for FakeFeed {
    async fn snapshot(
        &self,
        after_sequence: u64,
        watermark_sequence: Option<u64>,
        limit: u32,
        now: i64,
    ) -> Result<PrincipalRevocationSnapshotPage, PrincipalRevocationFeedError> {
        self.snapshot_calls
            .lock()
            .expect("snapshot calls lock")
            .push(SnapshotCall {
                after_sequence,
                watermark_sequence,
                limit,
                now,
            });
        self.snapshots
            .lock()
            .expect("snapshots lock")
            .pop_front()
            .expect("queued snapshot")
    }

    async fn read(
        &self,
        cursor: &PrincipalRevocationCursor,
        limit: u32,
        now: i64,
    ) -> Result<PrincipalRevocationReadPage, PrincipalRevocationFeedError> {
        self.read_calls
            .lock()
            .expect("read calls lock")
            .push(ReadCall {
                stream_id: cursor.stream_id().to_string(),
                sequence: cursor.sequence(),
                limit,
                now,
            });
        self.reads
            .lock()
            .expect("reads lock")
            .pop_front()
            .expect("queued read")
    }
}

#[tokio::test]
async fn preloads_one_fixed_watermark_then_advances_the_exact_cursor() {
    let feed = FakeFeed::new(
        vec![
            Ok(snapshot_page(
                STREAM_ID,
                /*watermark_sequence*/ 2,
                vec![revocation(/*sequence*/ 1)],
                Some(1),
            )),
            Ok(snapshot_page(
                STREAM_ID,
                /*watermark_sequence*/ 2,
                vec![revocation(/*sequence*/ 2)],
                /*next_after_sequence*/ None,
            )),
        ],
        vec![Ok(PrincipalRevocationReadPage {
            data: vec![revocation(/*sequence*/ 3)],
            cursor: cursor(STREAM_ID, /*sequence*/ 3),
        })],
    );
    let registry = TransportPrincipalRevocationRegistry::new();
    let listener = PrincipalRevocationListener::new(
        &feed,
        &registry,
        settings(/*page_size*/ 1, /*max_revocations*/ 4),
    );

    let ready = listener.prepare(/*now*/ 1_000).await.expect("prepare");
    assert_eq!(ready.loaded_revocations(), 2);
    assert!(!registry.is_freshness_unknown());
    assert_eq!(
        *feed.snapshot_calls.lock().expect("snapshot calls lock"),
        vec![
            SnapshotCall {
                after_sequence: 0,
                watermark_sequence: None,
                limit: 1,
                now: 1_000,
            },
            SnapshotCall {
                after_sequence: 1,
                watermark_sequence: Some(2),
                limit: 1,
                now: 1_000,
            },
        ]
    );
    assert_eq!(
        *feed.read_calls.lock().expect("read calls lock"),
        vec![ReadCall {
            stream_id: STREAM_ID.to_string(),
            sequence: 2,
            limit: 1,
            now: 1_000,
        }]
    );
}

#[tokio::test]
async fn preload_stream_or_watermark_drift_permanently_fails_closed() {
    for second_page in [
        snapshot_page(
            OTHER_STREAM_ID,
            /*watermark_sequence*/ 2,
            vec![revocation(/*sequence*/ 2)],
            /*next_after_sequence*/ None,
        ),
        snapshot_page(
            STREAM_ID,
            /*watermark_sequence*/ 3,
            vec![revocation(/*sequence*/ 2)],
            /*next_after_sequence*/ None,
        ),
    ] {
        let feed = FakeFeed::new(
            vec![
                Ok(snapshot_page(
                    STREAM_ID,
                    /*watermark_sequence*/ 2,
                    vec![revocation(/*sequence*/ 1)],
                    Some(1),
                )),
                Ok(second_page),
            ],
            Vec::new(),
        );
        let registry = TransportPrincipalRevocationRegistry::new();
        let listener = PrincipalRevocationListener::new(
            &feed,
            &registry,
            settings(/*page_size*/ 1, /*max_revocations*/ 4),
        );

        assert_eq!(
            listener
                .preload(/*now*/ 1_000)
                .await
                .expect_err("source identity drift must fail"),
            PrincipalRevocationListenerError::InvalidEvent
        );
        assert!(registry.is_freshness_unknown());
    }
}

#[tokio::test]
async fn source_loss_and_preload_capacity_exhaustion_fail_closed() {
    let source_loss = FakeFeed::new(
        vec![Ok(snapshot_page(
            STREAM_ID,
            /*watermark_sequence*/ 0,
            Vec::new(),
            /*next_after_sequence*/ None,
        ))],
        vec![Err(PrincipalRevocationFeedError::Unavailable)],
    );
    let source_loss_registry = TransportPrincipalRevocationRegistry::new();
    let source_loss_listener = PrincipalRevocationListener::new(
        &source_loss,
        &source_loss_registry,
        settings(/*page_size*/ 1, /*max_revocations*/ 4),
    );
    assert_eq!(
        source_loss_listener
            .prepare(/*now*/ 1_000)
            .await
            .expect_err("source loss must fail"),
        PrincipalRevocationListenerError::SourceUnavailable
    );
    assert!(source_loss_registry.is_freshness_unknown());

    let overflow = FakeFeed::new(
        vec![Ok(snapshot_page(
            STREAM_ID,
            /*watermark_sequence*/ 2,
            vec![revocation(/*sequence*/ 1), revocation(/*sequence*/ 2)],
            /*next_after_sequence*/ None,
        ))],
        Vec::new(),
    );
    let overflow_registry = TransportPrincipalRevocationRegistry::new();
    let overflow_listener = PrincipalRevocationListener::new(
        &overflow,
        &overflow_registry,
        settings(/*page_size*/ 2, /*max_revocations*/ 1),
    );
    assert_eq!(
        overflow_listener
            .preload(/*now*/ 1_000)
            .await
            .expect_err("snapshot capacity must fail"),
        PrincipalRevocationListenerError::CapacityExceeded
    );
    assert!(overflow_registry.is_freshness_unknown());
}

#[tokio::test]
async fn supervised_listener_stops_cleanly_without_consuming_another_cursor() {
    let feed = FakeFeed::new(
        vec![Ok(snapshot_page(
            STREAM_ID,
            /*watermark_sequence*/ 0,
            Vec::new(),
            /*next_after_sequence*/ None,
        ))],
        Vec::new(),
    );
    let registry = TransportPrincipalRevocationRegistry::new();
    let listener = PrincipalRevocationListener::new(
        &feed,
        &registry,
        settings(/*page_size*/ 1, /*max_revocations*/ 4),
    );
    let ready = listener.preload(/*now*/ 1_000).await.expect("preload");
    let cancellation = CancellationToken::new();
    cancellation.cancel();

    listener
        .run(ready, &cancellation)
        .await
        .expect("clean shutdown");
    assert!(feed.read_calls.lock().expect("read calls lock").is_empty());
    assert!(!registry.is_freshness_unknown());
}

fn settings(page_size: u32, max_revocations: usize) -> PrincipalRevocationListenerSettings {
    PrincipalRevocationListenerSettings::new(page_size, max_revocations).expect("settings")
}

fn cursor(stream_id: &str, sequence: u64) -> PrincipalRevocationCursor {
    PrincipalRevocationCursor::new(PrincipalRevocationCursorSpec {
        stream_id: stream_id.to_string(),
        sequence,
    })
    .expect("cursor")
}

fn revocation(sequence: u64) -> PrincipalRevocation {
    let timestamp_offset = i64::try_from(sequence).expect("test sequence fits i64");
    PrincipalRevocation::new(PrincipalRevocationSpec {
        sequence,
        issuer: "agent-platform".to_string(),
        session_jti: format!("019f7000-0000-7000-8000-{sequence:012}"),
        expires_at: 1_300 + timestamp_offset,
        revoked_at: 900 + timestamp_offset,
    })
    .expect("revocation")
}

fn snapshot_page(
    stream_id: &str,
    watermark_sequence: u64,
    data: Vec<PrincipalRevocation>,
    next_after_sequence: Option<u64>,
) -> PrincipalRevocationSnapshotPage {
    PrincipalRevocationSnapshotPage {
        stream_id: stream_id.to_string(),
        watermark_sequence,
        data,
        next_after_sequence,
    }
}
