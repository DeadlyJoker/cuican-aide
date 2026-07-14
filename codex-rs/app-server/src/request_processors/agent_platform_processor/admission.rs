use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Weak;

use crewon_app_server_protocol::JSONRPCErrorError;
use reqwest::StatusCode;
use tokio::sync::Mutex;
use tokio::sync::OwnedSemaphorePermit;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

use crate::error_code::internal_error;
use crate::outgoing_message::ConnectionId;

use super::remote::remote_error;

const MAX_ACTIVE_REQUESTS: usize = 64;
const MAX_ACTIVE_REQUESTS_PER_CONNECTION: usize = 8;

pub(super) struct AdmissionController {
    global: Arc<Semaphore>,
    per_connection: Mutex<HashMap<ConnectionId, Weak<Semaphore>>>,
}

pub(super) struct AdmissionPermit {
    _connection: OwnedSemaphorePermit,
    _global: OwnedSemaphorePermit,
}

impl AdmissionController {
    pub(super) fn new() -> Self {
        Self {
            global: Arc::new(Semaphore::new(MAX_ACTIVE_REQUESTS)),
            per_connection: Mutex::new(HashMap::new()),
        }
    }

    pub(super) async fn acquire(
        &self,
        connection_id: ConnectionId,
        cancellation: &CancellationToken,
    ) -> Result<AdmissionPermit, JSONRPCErrorError> {
        if cancellation.is_cancelled() {
            return Err(internal_error("Agent Platform connection closed"));
        }

        let connection = {
            let mut per_connection = self.per_connection.lock().await;
            per_connection.retain(|_, semaphore| semaphore.strong_count() > 0);
            if let Some(semaphore) = per_connection.get(&connection_id).and_then(Weak::upgrade) {
                semaphore
            } else {
                let semaphore = Arc::new(Semaphore::new(MAX_ACTIVE_REQUESTS_PER_CONNECTION));
                per_connection.insert(connection_id, Arc::downgrade(&semaphore));
                semaphore
            }
        };

        let global = Arc::clone(&self.global)
            .try_acquire_owned()
            .map_err(|_| active_request_limit_error())?;
        let connection = connection
            .try_acquire_owned()
            .map_err(|_| active_request_limit_error())?;
        if cancellation.is_cancelled() {
            return Err(internal_error("Agent Platform connection closed"));
        }
        Ok(AdmissionPermit {
            _connection: connection,
            _global: global,
        })
    }

    pub(super) async fn connection_closed(&self, connection_id: ConnectionId) {
        self.per_connection.lock().await.remove(&connection_id);
    }
}

fn active_request_limit_error() -> JSONRPCErrorError {
    remote_error(
        StatusCode::TOO_MANY_REQUESTS,
        "Agent Platform active request limit reached",
    )
}
