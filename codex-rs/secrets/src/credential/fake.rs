use std::collections::BTreeMap;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use super::CredentialAccess;
use super::CredentialAccessRequest;
use super::CredentialCreateRequest;
use super::CredentialId;
use super::CredentialMetadata;
use super::CredentialRotateRequest;
use super::CredentialStore;
use super::CredentialStoreError;
use super::engine::CredentialIdSource;
use super::engine::CredentialRecordBackend;
use super::engine::CredentialStoreEngine;
use super::engine::StoredCredential;

struct SequentialCredentialIdSource(AtomicU64);

impl Default for SequentialCredentialIdSource {
    fn default() -> Self {
        Self(AtomicU64::new(1))
    }
}

impl CredentialIdSource for SequentialCredentialIdSource {
    fn next_id(&self) -> Result<CredentialId, CredentialStoreError> {
        let sequence = self.0.fetch_add(1, Ordering::Relaxed);
        CredentialId::parse(&format!("cred_{sequence:032x}"))
    }
}

#[derive(Default)]
struct InMemoryCredentialRecordBackend {
    records: Mutex<BTreeMap<CredentialId, StoredCredential>>,
}

impl CredentialRecordBackend for InMemoryCredentialRecordBackend {
    fn insert(&self, record: &StoredCredential) -> Result<bool, CredentialStoreError> {
        let mut records = self.records.lock().map_err(lock_error)?;
        if records.contains_key(&record.credential_id) {
            return Ok(false);
        }
        records.insert(record.credential_id.clone(), record.clone());
        Ok(true)
    }

    fn load(
        &self,
        credential_id: &CredentialId,
    ) -> Result<Option<StoredCredential>, CredentialStoreError> {
        let records = self.records.lock().map_err(lock_error)?;
        Ok(records.get(credential_id).cloned())
    }

    fn save(&self, record: &StoredCredential) -> Result<(), CredentialStoreError> {
        let mut records = self.records.lock().map_err(lock_error)?;
        records.insert(record.credential_id.clone(), record.clone());
        Ok(())
    }
}

/// Deterministic in-memory Credential adapter for lifecycle and authorization harnesses.
pub struct FakeCredentialStore {
    engine: CredentialStoreEngine<InMemoryCredentialRecordBackend, SequentialCredentialIdSource>,
}

impl Default for FakeCredentialStore {
    fn default() -> Self {
        Self {
            engine: CredentialStoreEngine {
                backend: InMemoryCredentialRecordBackend::default(),
                id_source: SequentialCredentialIdSource::default(),
            },
        }
    }
}

impl CredentialStore for FakeCredentialStore {
    fn create(
        &self,
        request: CredentialCreateRequest,
    ) -> Result<CredentialMetadata, CredentialStoreError> {
        self.engine.create(request)
    }

    fn inspect(
        &self,
        request: CredentialAccessRequest,
    ) -> Result<CredentialMetadata, CredentialStoreError> {
        self.engine.inspect(request)
    }

    fn read(
        &self,
        request: CredentialAccessRequest,
    ) -> Result<CredentialAccess, CredentialStoreError> {
        self.engine.read(request)
    }

    fn rotate(
        &self,
        request: CredentialRotateRequest,
    ) -> Result<CredentialMetadata, CredentialStoreError> {
        self.engine.rotate(request)
    }

    fn revoke(
        &self,
        request: CredentialAccessRequest,
    ) -> Result<CredentialMetadata, CredentialStoreError> {
        self.engine.revoke(request)
    }
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> CredentialStoreError {
    CredentialStoreError::Unavailable("credential store lock poisoned")
}
