use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Weak;

use crewon_protocol::ThreadId;
use tokio::sync::Mutex;
use tokio::sync::OwnedMutexGuard;

/// Serializes capability decisions and mutations that target the same Office manager thread.
#[derive(Clone, Default)]
pub(crate) struct OfficeThreadCapabilityLocks {
    locks: Arc<Mutex<HashMap<String, Weak<Mutex<()>>>>>,
}

impl OfficeThreadCapabilityLocks {
    pub(crate) async fn acquire(&self, thread_id: &str) -> OwnedMutexGuard<()> {
        let thread_id = canonical_thread_id(thread_id);
        let lock = {
            let mut locks = self.locks.lock().await;
            locks.retain(|_, lock| lock.strong_count() > 0);
            match locks.get(&thread_id).and_then(Weak::upgrade) {
                Some(lock) => lock,
                None => {
                    let lock = Arc::new(Mutex::new(()));
                    locks.insert(thread_id, Arc::downgrade(&lock));
                    lock
                }
            }
        };
        lock.lock_owned().await
    }
}

fn canonical_thread_id(thread_id: &str) -> String {
    ThreadId::from_string(thread_id)
        .map(|thread_id| thread_id.to_string())
        .unwrap_or_else(|_| thread_id.trim().to_string())
}

#[cfg(test)]
#[path = "office_thread_capability_tests.rs"]
mod tests;
