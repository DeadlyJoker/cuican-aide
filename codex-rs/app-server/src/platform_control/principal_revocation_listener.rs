use std::future::Future;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use crewon_app_server_transport::TransportAuthenticatedPrincipalSource;
use crewon_app_server_transport::TransportPrincipalRevocation;
use crewon_app_server_transport::TransportPrincipalRevocationRegistry;
use crewon_app_server_transport::TransportPrincipalRevocationSpec;
use crewon_provider_agent_platform::PrincipalRevocationCursor;
use crewon_provider_agent_platform::PrincipalRevocationCursorSpec;
use crewon_provider_agent_platform::PrincipalRevocationReadPage;
use crewon_provider_agent_platform::PrincipalRevocationSnapshotPage;
use tokio_util::sync::CancellationToken;

const REGISTRY_CAPACITY: usize = 4_096;
const POLL_INTERVAL: Duration = Duration::from_secs(1);
const SOURCE_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// Supplies one validated, monotonic Agent Platform revocation stream.
///
/// Implementations must preserve the source cursor exactly and must never
/// synthesize events after transport, authorization, or validation failures.
pub(crate) trait PrincipalRevocationFeed: Send + Sync {
    fn snapshot(
        &self,
        after_sequence: u64,
        watermark_sequence: Option<u64>,
        limit: u32,
        now: i64,
    ) -> impl Future<Output = Result<PrincipalRevocationSnapshotPage, PrincipalRevocationFeedError>> + Send;

    fn read(
        &self,
        cursor: &PrincipalRevocationCursor,
        limit: u32,
        now: i64,
    ) -> impl Future<Output = Result<PrincipalRevocationReadPage, PrincipalRevocationFeedError>> + Send;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum PrincipalRevocationFeedError {
    #[error("principal revocation feed is unavailable")]
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PrincipalRevocationListenerSettings {
    page_size: u32,
    max_revocations: usize,
}

impl PrincipalRevocationListenerSettings {
    pub(crate) fn new(page_size: u32, max_revocations: usize) -> Result<Self, ()> {
        if page_size == 0
            || page_size > 100
            || max_revocations == 0
            || max_revocations > REGISTRY_CAPACITY
        {
            return Err(());
        }
        Ok(Self {
            page_size,
            max_revocations,
        })
    }
}

#[derive(Debug)]
pub(crate) struct ReadyPrincipalRevocationCursor {
    cursor: PrincipalRevocationCursor,
    loaded_revocations: usize,
}

impl ReadyPrincipalRevocationCursor {
    pub(crate) fn loaded_revocations(&self) -> usize {
        self.loaded_revocations
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum PrincipalRevocationListenerError {
    #[error("principal revocation source is unavailable")]
    SourceUnavailable,
    #[error("principal revocation source exceeded the configured capacity")]
    CapacityExceeded,
    #[error("principal revocation event is invalid")]
    InvalidEvent,
}

pub(crate) struct PrincipalRevocationListener<'a, Feed> {
    feed: &'a Feed,
    registry: &'a TransportPrincipalRevocationRegistry,
    settings: PrincipalRevocationListenerSettings,
}

impl<'a, Feed> PrincipalRevocationListener<'a, Feed>
where
    Feed: PrincipalRevocationFeed,
{
    pub(crate) fn new(
        feed: &'a Feed,
        registry: &'a TransportPrincipalRevocationRegistry,
        settings: PrincipalRevocationListenerSettings,
    ) -> Self {
        Self {
            feed,
            registry,
            settings,
        }
    }

    pub(crate) async fn preload(
        &self,
        now: i64,
    ) -> Result<ReadyPrincipalRevocationCursor, PrincipalRevocationListenerError> {
        let result = self.preload_inner(now).await;
        if result.is_err() {
            self.registry.mark_freshness_unknown();
        }
        result
    }

    /// Loads the bounded authoritative snapshot and immediately catches up from
    /// its fixed watermark before a WebSocket listener is allowed to start.
    pub(crate) async fn prepare(
        &self,
        now: i64,
    ) -> Result<ReadyPrincipalRevocationCursor, PrincipalRevocationListenerError> {
        let ready = self.preload(now).await?;
        self.poll_once(ready, now).await
    }

    /// Maintains the gap-free cursor until shutdown or permanent freshness loss.
    pub(crate) async fn run(
        &self,
        mut ready: ReadyPrincipalRevocationCursor,
        cancellation: &CancellationToken,
    ) -> Result<(), PrincipalRevocationListenerError> {
        loop {
            tokio::select! {
                _ = cancellation.cancelled() => return Ok(()),
                _ = tokio::time::sleep(POLL_INTERVAL) => {}
            }
            let now = unix_timestamp_now().inspect_err(|_| {
                self.registry.mark_freshness_unknown();
            })?;
            ready = self.poll_once(ready, now).await?;
        }
    }

    async fn preload_inner(
        &self,
        now: i64,
    ) -> Result<ReadyPrincipalRevocationCursor, PrincipalRevocationListenerError> {
        if now < 0 {
            return Err(PrincipalRevocationListenerError::InvalidEvent);
        }
        let mut after_sequence = 0;
        let mut watermark_sequence = None;
        let mut stream_id = None;
        let mut loaded_revocations: usize = 0;
        loop {
            let page = tokio::time::timeout(
                SOURCE_REQUEST_TIMEOUT,
                self.feed.snapshot(
                    after_sequence,
                    watermark_sequence,
                    self.settings.page_size,
                    now,
                ),
            )
            .await
            .map_err(|_| PrincipalRevocationListenerError::SourceUnavailable)?
            .map_err(|_| PrincipalRevocationListenerError::SourceUnavailable)?;
            validate_snapshot_page(&page, after_sequence, watermark_sequence)?;
            if stream_id
                .as_ref()
                .is_some_and(|expected| expected != &page.stream_id)
            {
                return Err(PrincipalRevocationListenerError::InvalidEvent);
            }
            stream_id = Some(page.stream_id.clone());
            watermark_sequence = Some(page.watermark_sequence);
            loaded_revocations = loaded_revocations
                .checked_add(page.data.len())
                .ok_or(PrincipalRevocationListenerError::CapacityExceeded)?;
            if loaded_revocations > self.settings.max_revocations {
                return Err(PrincipalRevocationListenerError::CapacityExceeded);
            }
            publish(self.registry, &page.data, now)?;
            let Some(next) = page.next_after_sequence else {
                let cursor = PrincipalRevocationCursor::new(PrincipalRevocationCursorSpec {
                    stream_id: page.stream_id,
                    sequence: page.watermark_sequence,
                })
                .map_err(|_| PrincipalRevocationListenerError::InvalidEvent)?;
                return Ok(ReadyPrincipalRevocationCursor {
                    cursor,
                    loaded_revocations,
                });
            };
            if next <= after_sequence {
                return Err(PrincipalRevocationListenerError::InvalidEvent);
            }
            after_sequence = next;
        }
    }

    pub(crate) async fn poll_once(
        &self,
        ready: ReadyPrincipalRevocationCursor,
        now: i64,
    ) -> Result<ReadyPrincipalRevocationCursor, PrincipalRevocationListenerError> {
        let result = self.poll_once_inner(ready, now).await;
        if result.is_err() {
            self.registry.mark_freshness_unknown();
        }
        result
    }

    async fn poll_once_inner(
        &self,
        ready: ReadyPrincipalRevocationCursor,
        now: i64,
    ) -> Result<ReadyPrincipalRevocationCursor, PrincipalRevocationListenerError> {
        if now < 0 {
            return Err(PrincipalRevocationListenerError::InvalidEvent);
        }
        let previous_stream_id = ready.cursor.stream_id();
        let previous_sequence = ready.cursor.sequence();
        let page = tokio::time::timeout(
            SOURCE_REQUEST_TIMEOUT,
            self.feed.read(&ready.cursor, self.settings.page_size, now),
        )
        .await
        .map_err(|_| PrincipalRevocationListenerError::SourceUnavailable)?
        .map_err(|_| PrincipalRevocationListenerError::SourceUnavailable)?;
        if page.cursor.stream_id() != previous_stream_id
            || page.cursor.sequence() < previous_sequence
        {
            return Err(PrincipalRevocationListenerError::InvalidEvent);
        }
        validate_events(&page.data, previous_sequence, page.cursor.sequence())?;
        publish(self.registry, &page.data, now)?;
        Ok(ReadyPrincipalRevocationCursor {
            cursor: page.cursor,
            loaded_revocations: ready.loaded_revocations,
        })
    }
}

fn validate_snapshot_page(
    page: &PrincipalRevocationSnapshotPage,
    after_sequence: u64,
    expected_watermark: Option<u64>,
) -> Result<(), PrincipalRevocationListenerError> {
    if page.watermark_sequence < after_sequence
        || expected_watermark.is_some_and(|expected| expected != page.watermark_sequence)
    {
        return Err(PrincipalRevocationListenerError::InvalidEvent);
    }
    PrincipalRevocationCursor::new(PrincipalRevocationCursorSpec {
        stream_id: page.stream_id.clone(),
        sequence: page.watermark_sequence,
    })
    .map_err(|_| PrincipalRevocationListenerError::InvalidEvent)?;
    validate_events(&page.data, after_sequence, page.watermark_sequence)?;
    if page.next_after_sequence.is_some_and(|next| {
        next <= after_sequence
            || next > page.watermark_sequence
            || page
                .data
                .last()
                .map(crewon_provider_agent_platform::PrincipalRevocation::sequence)
                != Some(next)
    }) {
        return Err(PrincipalRevocationListenerError::InvalidEvent);
    }
    Ok(())
}

fn validate_events(
    events: &[crewon_provider_agent_platform::PrincipalRevocation],
    after_sequence: u64,
    maximum_sequence: u64,
) -> Result<(), PrincipalRevocationListenerError> {
    let mut previous = after_sequence;
    for event in events {
        if event.sequence() <= previous || event.sequence() > maximum_sequence {
            return Err(PrincipalRevocationListenerError::InvalidEvent);
        }
        previous = event.sequence();
    }
    Ok(())
}

fn publish(
    registry: &TransportPrincipalRevocationRegistry,
    events: &[crewon_provider_agent_platform::PrincipalRevocation],
    now: i64,
) -> Result<(), PrincipalRevocationListenerError> {
    for event in events {
        let revocation = TransportPrincipalRevocation::new(TransportPrincipalRevocationSpec {
            source: TransportAuthenticatedPrincipalSource::WebSocketPrincipalSessionRs256,
            issuer: event.issuer().to_string(),
            token_id: event.session_jti().to_string(),
            expires_at: event.expires_at(),
        })
        .map_err(|_| PrincipalRevocationListenerError::InvalidEvent)?;
        registry
            .revoke_at(revocation, now)
            .map_err(|_| PrincipalRevocationListenerError::InvalidEvent)?;
    }
    Ok(())
}

fn unix_timestamp_now() -> Result<i64, PrincipalRevocationListenerError> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| PrincipalRevocationListenerError::InvalidEvent)?;
    i64::try_from(elapsed.as_secs()).map_err(|_| PrincipalRevocationListenerError::InvalidEvent)
}
