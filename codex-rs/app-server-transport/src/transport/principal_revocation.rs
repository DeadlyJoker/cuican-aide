use super::TransportAuthenticatedPrincipal;
use super::TransportAuthenticatedPrincipalSource;
use super::TransportAuthentication;
use super::auth::MAX_SIGNED_BEARER_CLOCK_SKEW_SECONDS;
use super::authenticated_principal::MAX_AUTHENTICATED_LIFETIME_SECONDS;
use super::authenticated_principal::MAX_AUTHORITY_ID_BYTES;
use super::authenticated_principal::validate_id;
use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;
use tokio::sync::broadcast;

pub(super) const MAX_ACTIVE_REVOCATIONS: usize = 4_096;
const REVOCATION_EVENT_CHANNEL_CAPACITY: usize = 128;
const MAX_REVOCATION_RETENTION_SECONDS: i64 =
    MAX_AUTHENTICATED_LIFETIME_SECONDS + MAX_SIGNED_BEARER_CLOCK_SKEW_SECONDS as i64;

#[derive(Clone, Eq, Hash, PartialEq)]
struct PrincipalRevocationKey {
    source: TransportAuthenticatedPrincipalSource,
    issuer: String,
    token_id: String,
}

impl PrincipalRevocationKey {
    fn from_verified_principal(principal: &TransportAuthenticatedPrincipal) -> Self {
        Self {
            source: principal.source(),
            issuer: principal.issuer().to_string(),
            token_id: principal.token_id().to_string(),
        }
    }
}

impl fmt::Debug for PrincipalRevocationKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PrincipalRevocationKey")
            .field("source", &self.source)
            .field("issuer", &"[REDACTED]")
            .field("token_id", &"[REDACTED]")
            .finish()
    }
}

/// Validated input published by a trusted principal revocation source.
///
/// The event identifies one issuer-scoped token session and is retained only
/// until that token's verified expiry. It never contains the raw bearer token.
#[derive(Clone, Eq, PartialEq)]
pub struct TransportPrincipalRevocation {
    key: PrincipalRevocationKey,
    expires_at: i64,
}

/// Self-documenting fields used to construct a revocation from an external
/// identity provider or logout adapter.
#[derive(Clone, Eq, PartialEq)]
pub struct TransportPrincipalRevocationSpec {
    /// Trusted transport mechanism whose verifier minted the principal.
    pub source: TransportAuthenticatedPrincipalSource,
    /// Exact issuer that scoped the JTI.
    pub issuer: String,
    /// Exact JWT ID or equivalent token-session identifier.
    pub token_id: String,
    /// Verified Unix expiry of the revoked token session.
    pub expires_at: i64,
}

impl TransportPrincipalRevocation {
    /// Validates a revocation event supplied by a trusted external source.
    pub fn new(
        spec: TransportPrincipalRevocationSpec,
    ) -> Result<Self, TransportPrincipalRevocationError> {
        validate_id(&spec.issuer, MAX_AUTHORITY_ID_BYTES)
            .map_err(|_| TransportPrincipalRevocationError::Invalid)?;
        validate_id(&spec.token_id, MAX_AUTHORITY_ID_BYTES)
            .map_err(|_| TransportPrincipalRevocationError::Invalid)?;
        if spec.expires_at < 0 {
            return Err(TransportPrincipalRevocationError::Invalid);
        }
        Ok(Self {
            key: PrincipalRevocationKey {
                source: spec.source,
                issuer: spec.issuer,
                token_id: spec.token_id,
            },
            expires_at: spec.expires_at,
        })
    }

    /// Creates an exact revocation for claims already verified by this crate.
    pub fn for_verified_principal(principal: &TransportAuthenticatedPrincipal) -> Self {
        Self {
            key: PrincipalRevocationKey::from_verified_principal(principal),
            expires_at: principal.expires_at(),
        }
    }
}

impl fmt::Debug for TransportPrincipalRevocation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TransportPrincipalRevocation")
            .field("source", &self.key.source)
            .field("issuer", &"[REDACTED]")
            .field("token_id", &"[REDACTED]")
            .field("expires_at", &"[REDACTED]")
            .finish()
    }
}

/// Failure returned when a trusted source publishes an unsafe revocation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TransportPrincipalRevocationError {
    /// The issuer, token ID, or expiry shape is invalid.
    Invalid,
    /// The revocation arrived after its token session expired.
    Expired,
    /// The requested retention exceeds the hard in-memory bound.
    RetentionTooLong,
}

impl fmt::Display for TransportPrincipalRevocationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid => formatter.write_str("principal revocation is invalid"),
            Self::Expired => formatter.write_str("principal revocation is already expired"),
            Self::RetentionTooLong => {
                formatter.write_str("principal revocation retention exceeds the hard limit")
            }
        }
    }
}

impl std::error::Error for TransportPrincipalRevocationError {}

/// Bounded in-memory source of truth for active principal revocations.
///
/// Clones share one registry. A trusted logout or identity-provider adapter
/// publishes exact revocations through [`Self::revoke`], while revocation-aware
/// transports subscribe before admitting a verified connection.
#[derive(Clone)]
pub struct TransportPrincipalRevocationRegistry {
    inner: Arc<PrincipalRevocationRegistryInner>,
}

struct PrincipalRevocationRegistryInner {
    state: Mutex<PrincipalRevocationState>,
    event_tx: broadcast::Sender<PrincipalRevocationNotice>,
}

#[derive(Default)]
struct PrincipalRevocationState {
    revoked: HashMap<PrincipalRevocationKey, i64>,
    fail_closed_until: Option<i64>,
    freshness_unknown: bool,
}

#[derive(Clone)]
enum PrincipalRevocationNotice {
    Key(PrincipalRevocationKey),
    FailClosed,
}

impl Default for TransportPrincipalRevocationRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl TransportPrincipalRevocationRegistry {
    /// Creates an empty registry with known freshness.
    ///
    /// An external source must preload its authoritative snapshot before this
    /// registry is passed to a listener.
    pub fn new() -> Self {
        let (event_tx, _) = broadcast::channel(REVOCATION_EVENT_CHANNEL_CAPACITY);
        Self {
            inner: Arc::new(PrincipalRevocationRegistryInner {
                state: Mutex::new(PrincipalRevocationState::default()),
                event_tx,
            }),
        }
    }

    /// Publishes one exact, unexpired revocation idempotently.
    pub fn revoke(
        &self,
        revocation: TransportPrincipalRevocation,
    ) -> Result<(), TransportPrincipalRevocationError> {
        self.revoke_at(revocation, unix_timestamp_now())
    }

    /// Permanently fails this registry closed after its authoritative source
    /// loses a gap-free cursor or can no longer prove revocation freshness.
    ///
    /// Active authenticated connections are disconnected and new ones are
    /// rejected. Recovery intentionally requires loading a fresh registry and
    /// restarting the listener so an adapter cannot clear this state without
    /// first rebuilding an authoritative snapshot.
    pub fn mark_freshness_unknown(&self) {
        {
            let mut state = self.lock_state();
            state.freshness_unknown = true;
        }
        let _ = self
            .inner
            .event_tx
            .send(PrincipalRevocationNotice::FailClosed);
    }

    /// Reports whether this registry permanently lost authoritative source freshness.
    pub fn is_freshness_unknown(&self) -> bool {
        self.lock_state().freshness_unknown
    }

    /// Publishes a revocation using an adapter-supplied, already validated Unix time.
    pub fn revoke_at(
        &self,
        revocation: TransportPrincipalRevocation,
        now: i64,
    ) -> Result<(), TransportPrincipalRevocationError> {
        if now < 0 {
            return Err(TransportPrincipalRevocationError::Invalid);
        }
        if revocation.expires_at <= now {
            return Err(TransportPrincipalRevocationError::Expired);
        }
        if revocation.expires_at.saturating_sub(now) > MAX_REVOCATION_RETENTION_SECONDS {
            return Err(TransportPrincipalRevocationError::RetentionTooLong);
        }

        let notice = {
            let mut state = self.lock_state();
            state.purge_expired(now);
            if state.freshness_unknown {
                PrincipalRevocationNotice::FailClosed
            } else if let Some(fail_closed_until) = state.fail_closed_until.as_mut() {
                *fail_closed_until = (*fail_closed_until).max(revocation.expires_at);
                PrincipalRevocationNotice::FailClosed
            } else if let Some(expires_at) = state.revoked.get_mut(&revocation.key) {
                *expires_at = (*expires_at).max(revocation.expires_at);
                PrincipalRevocationNotice::Key(revocation.key)
            } else if state.revoked.len() < MAX_ACTIVE_REVOCATIONS {
                state
                    .revoked
                    .insert(revocation.key.clone(), revocation.expires_at);
                PrincipalRevocationNotice::Key(revocation.key)
            } else {
                let fail_closed_until = state
                    .revoked
                    .values()
                    .copied()
                    .max()
                    .unwrap_or(now)
                    .max(revocation.expires_at);
                state.revoked.clear();
                state.fail_closed_until = Some(fail_closed_until);
                PrincipalRevocationNotice::FailClosed
            }
        };
        let _ = self.inner.event_tx.send(notice);
        Ok(())
    }

    pub(crate) fn subscribe(
        &self,
        authentication: &TransportAuthentication,
    ) -> PrincipalRevocationSubscriptionState {
        self.subscribe_at(authentication, unix_timestamp_now())
    }

    pub(super) fn subscribe_at(
        &self,
        authentication: &TransportAuthentication,
        now: i64,
    ) -> PrincipalRevocationSubscriptionState {
        let TransportAuthentication::AuthenticatedPrincipal(principal) = authentication else {
            return PrincipalRevocationSubscriptionState::NotApplicable;
        };
        let key = PrincipalRevocationKey::from_verified_principal(principal);
        let event_rx = self.inner.event_tx.subscribe();
        if self.is_key_revoked_at(&key, now) {
            PrincipalRevocationSubscriptionState::Revoked
        } else {
            PrincipalRevocationSubscriptionState::Active(TransportPrincipalRevocationSubscription {
                registry: self.clone(),
                key,
                event_rx,
            })
        }
    }

    fn is_key_revoked(&self, key: &PrincipalRevocationKey) -> bool {
        self.is_key_revoked_at(key, unix_timestamp_now())
    }

    fn is_key_revoked_at(&self, key: &PrincipalRevocationKey, now: i64) -> bool {
        let mut state = self.lock_state();
        state.purge_expired(now);
        state.freshness_unknown
            || state.fail_closed_until.is_some()
            || state.revoked.contains_key(key)
    }

    fn lock_state(&self) -> MutexGuard<'_, PrincipalRevocationState> {
        match self.inner.state.lock() {
            Ok(state) => state,
            Err(poisoned) => {
                let mut state = poisoned.into_inner();
                state.freshness_unknown = true;
                let _ = self
                    .inner
                    .event_tx
                    .send(PrincipalRevocationNotice::FailClosed);
                state
            }
        }
    }
}

impl PrincipalRevocationState {
    fn purge_expired(&mut self, now: i64) {
        self.revoked.retain(|_, expires_at| *expires_at > now);
        if self
            .fail_closed_until
            .is_some_and(|expires_at| expires_at <= now)
        {
            self.fail_closed_until = None;
        }
    }
}

pub(crate) enum PrincipalRevocationSubscriptionState {
    NotApplicable,
    Revoked,
    Active(TransportPrincipalRevocationSubscription),
}

pub(super) enum PrincipalRevocationGuard {
    NotApplicable,
    Active(TransportPrincipalRevocationSubscription),
}

impl PrincipalRevocationGuard {
    pub(super) fn is_revoked(&self) -> bool {
        match self {
            Self::NotApplicable => false,
            Self::Active(subscription) => subscription.is_revoked(),
        }
    }

    pub(super) async fn wait_until_revoked(self) {
        match self {
            Self::NotApplicable => std::future::pending().await,
            Self::Active(subscription) => subscription.wait_until_revoked().await,
        }
    }
}

impl fmt::Debug for PrincipalRevocationSubscriptionState {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotApplicable => formatter.write_str("NotApplicable"),
            Self::Revoked => formatter.write_str("Revoked"),
            Self::Active(_) => formatter.write_str("Active([REDACTED])"),
        }
    }
}

pub(crate) struct TransportPrincipalRevocationSubscription {
    registry: TransportPrincipalRevocationRegistry,
    key: PrincipalRevocationKey,
    event_rx: broadcast::Receiver<PrincipalRevocationNotice>,
}

impl TransportPrincipalRevocationSubscription {
    pub(crate) fn is_revoked(&self) -> bool {
        self.registry.is_key_revoked(&self.key)
    }

    pub(crate) async fn wait_until_revoked(mut self) {
        loop {
            if self.is_revoked() {
                return;
            }
            match self.event_rx.recv().await {
                Ok(PrincipalRevocationNotice::Key(key)) if key == self.key => return,
                Ok(PrincipalRevocationNotice::Key(_)) => {}
                Ok(PrincipalRevocationNotice::FailClosed)
                | Err(broadcast::error::RecvError::Closed) => return,
                Err(broadcast::error::RecvError::Lagged(_)) => {}
            }
        }
    }
}

fn unix_timestamp_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_secs()).ok())
        .unwrap_or(0)
}
