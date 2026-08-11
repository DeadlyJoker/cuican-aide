use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use zeroize::Zeroizing;

#[path = "provider_credentials_catalog_io.rs"]
mod catalog_io;

use self::catalog_io::read_catalog;
use self::catalog_io::read_optional_secure_json;
use self::catalog_io::remove_secure_file;
pub(super) use self::catalog_io::restrict_directory;
use self::catalog_io::write_catalog;
use self::catalog_io::write_secure_json;

use super::new_runtime_binding_id;
use super::validate_catalog;
use super::validate_provider_id;
use super::validated_binding;
use super::ActiveProviderBinding;
use super::ActiveProviderRuntime;
use super::ProviderBinding;
use super::ProviderCredentialBindingView;
use super::ProviderCredentialCatalogFile;
use super::ProviderCredentialCatalogView;
use super::ProviderCredentialError;
use super::ProviderCredentialKind;
use super::ProviderCredentialMutationError;
use super::ProviderCredentialMutationJournal;
use super::ProviderCredentialRecovery;
use super::ProviderCredentialRecoveryDisposition;
use super::ProviderCredentialTargetRequest;
use super::ProviderCredentialUpsertRequest;
use super::ProviderRuntimeMutation;
use super::ProviderRuntimeMutationBinding;
use super::ProviderRuntimeMutationFailure;
use super::ProviderSecretStore;
use super::SecretStoreError;
use super::MUTATION_JOURNAL_SCHEMA_VERSION;

pub(super) struct OsProviderSecretStore {
    pub(super) service: &'static str,
}

impl OsProviderSecretStore {
    fn entry(&self, provider_id: &str) -> Result<keyring::Entry, SecretStoreError> {
        keyring::Entry::new(self.service, provider_id).map_err(|_| SecretStoreError::Unavailable)
    }
}

impl ProviderSecretStore for OsProviderSecretStore {
    fn delete(&self, provider_id: &str) -> Result<(), SecretStoreError> {
        match self.entry(provider_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(SecretStoreError::Unavailable),
        }
    }

    fn get(&self, provider_id: &str) -> Result<Zeroizing<String>, SecretStoreError> {
        match self.entry(provider_id)?.get_password() {
            Ok(secret) => Ok(Zeroizing::new(secret)),
            Err(keyring::Error::NoEntry) => Err(SecretStoreError::Missing),
            Err(_) => Err(SecretStoreError::Unavailable),
        }
    }

    fn set(&self, provider_id: &str, secret: &str) -> Result<(), SecretStoreError> {
        self.entry(provider_id)?
            .set_password(secret)
            .map_err(|_| SecretStoreError::Unavailable)
    }
}

enum SecretSnapshot {
    Missing,
    Present(Zeroizing<String>),
}

enum SecretMutation<'a> {
    Delete,
    Keep,
    Require,
    Set(&'a str),
}

/// Serializes metadata, keyring, and Worker mutations into one observable
/// Provider change. The catalog mutex stays held across the supervised reload.
pub struct ProviderCredentialManager {
    catalog: Mutex<ProviderCredentialCatalogFile>,
    catalog_path: PathBuf,
    secrets: Arc<dyn ProviderSecretStore>,
}

impl ProviderCredentialManager {
    pub(super) fn open(
        catalog_path: PathBuf,
        secrets: Arc<dyn ProviderSecretStore>,
    ) -> Result<Self, ProviderCredentialError> {
        let mut catalog = read_catalog(&catalog_path)?;
        if catalog.active_provider_id.is_some() && catalog.active_runtime_binding_id.is_none() {
            catalog.active_runtime_binding_id = Some(new_runtime_binding_id()?);
            write_catalog(&catalog_path, &catalog)?;
        }
        validate_catalog(&catalog)?;
        Ok(Self {
            catalog: Mutex::new(catalog),
            catalog_path,
            secrets,
        })
    }

    pub(super) fn catalog_view(
        &self,
    ) -> Result<ProviderCredentialCatalogView, ProviderCredentialError> {
        let catalog = self
            .catalog
            .lock()
            .map_err(|_| ProviderCredentialError::StateUnavailable)?;
        Ok(catalog_view_for(self.secrets.as_ref(), &catalog))
    }

    #[cfg(test)]
    pub(super) fn upsert(
        &self,
        request: &ProviderCredentialUpsertRequest,
    ) -> Result<ProviderCredentialCatalogView, ProviderCredentialMutationError> {
        self.upsert_with_reload(request, |_, _| Ok(()))
    }

    #[cfg(test)]
    pub(super) fn upsert_with_reload(
        &self,
        request: &ProviderCredentialUpsertRequest,
        reload: impl FnOnce(
            Option<&ActiveProviderRuntime>,
            Option<&ActiveProviderRuntime>,
        ) -> Result<(), &'static str>,
    ) -> Result<ProviderCredentialCatalogView, ProviderCredentialMutationError> {
        self.upsert_with_coordinator(request, |mutation| {
            reload(mutation.previous_runtime, mutation.candidate_runtime)
                .map_err(ProviderRuntimeMutationFailure::BeforeCommit)
        })
    }

    pub(super) fn upsert_with_coordinator(
        &self,
        request: &ProviderCredentialUpsertRequest,
        coordinate: impl FnOnce(
            &ProviderRuntimeMutation<'_>,
        ) -> Result<(), ProviderRuntimeMutationFailure>,
    ) -> Result<ProviderCredentialCatalogView, ProviderCredentialMutationError> {
        let binding = validated_binding(request)?;
        let mut catalog = self
            .catalog
            .lock()
            .map_err(|_| ProviderCredentialError::StateUnavailable)?;
        let previous = catalog.clone();
        let mut next = previous.clone();
        next.bindings
            .insert(binding.provider_id.clone(), binding.clone());
        if request.activate {
            next.active_provider_id = Some(binding.provider_id.clone());
        }
        next.active_runtime_binding_id = if next.active_provider_id.is_some() {
            Some(new_runtime_binding_id()?)
        } else {
            None
        };
        let secret_mutation = match binding.credential_kind {
            ProviderCredentialKind::Keychain => match request.secret.as_deref() {
                Some(secret) => SecretMutation::Set(secret),
                None => SecretMutation::Require,
            },
            ProviderCredentialKind::Environment | ProviderCredentialKind::None => {
                SecretMutation::Delete
            }
        };
        self.commit_mutation(
            &mut catalog,
            previous,
            next,
            &binding.provider_id,
            secret_mutation,
            coordinate,
        )
    }

    #[cfg(test)]
    pub(super) fn activate_with_reload(
        &self,
        request: &ProviderCredentialTargetRequest,
        reload: impl FnOnce(
            Option<&ActiveProviderRuntime>,
            Option<&ActiveProviderRuntime>,
        ) -> Result<(), &'static str>,
    ) -> Result<ProviderCredentialCatalogView, ProviderCredentialMutationError> {
        self.activate_with_coordinator(request, |mutation| {
            reload(mutation.previous_runtime, mutation.candidate_runtime)
                .map_err(ProviderRuntimeMutationFailure::BeforeCommit)
        })
    }

    pub(super) fn activate_with_coordinator(
        &self,
        request: &ProviderCredentialTargetRequest,
        coordinate: impl FnOnce(
            &ProviderRuntimeMutation<'_>,
        ) -> Result<(), ProviderRuntimeMutationFailure>,
    ) -> Result<ProviderCredentialCatalogView, ProviderCredentialMutationError> {
        validate_provider_id(&request.provider_id)?;
        let mut catalog = self
            .catalog
            .lock()
            .map_err(|_| ProviderCredentialError::StateUnavailable)?;
        let previous = catalog.clone();
        let binding = previous
            .bindings
            .get(&request.provider_id)
            .ok_or(ProviderCredentialError::InvalidRequest)?;
        require_credential_available(self.secrets.as_ref(), binding)?;
        let mut next = previous.clone();
        next.active_provider_id = Some(request.provider_id.clone());
        next.active_runtime_binding_id = Some(new_runtime_binding_id()?);
        self.commit_mutation(
            &mut catalog,
            previous,
            next,
            &request.provider_id,
            SecretMutation::Keep,
            coordinate,
        )
    }

    #[cfg(test)]
    pub(super) fn delete(
        &self,
        request: &ProviderCredentialTargetRequest,
    ) -> Result<ProviderCredentialCatalogView, ProviderCredentialMutationError> {
        self.delete_with_reload(request, |_, _| Ok(()))
    }

    #[cfg(test)]
    pub(super) fn delete_with_reload(
        &self,
        request: &ProviderCredentialTargetRequest,
        reload: impl FnOnce(
            Option<&ActiveProviderRuntime>,
            Option<&ActiveProviderRuntime>,
        ) -> Result<(), &'static str>,
    ) -> Result<ProviderCredentialCatalogView, ProviderCredentialMutationError> {
        self.delete_with_coordinator(request, |mutation| {
            reload(mutation.previous_runtime, mutation.candidate_runtime)
                .map_err(ProviderRuntimeMutationFailure::BeforeCommit)
        })
    }

    pub(super) fn delete_with_coordinator(
        &self,
        request: &ProviderCredentialTargetRequest,
        coordinate: impl FnOnce(
            &ProviderRuntimeMutation<'_>,
        ) -> Result<(), ProviderRuntimeMutationFailure>,
    ) -> Result<ProviderCredentialCatalogView, ProviderCredentialMutationError> {
        validate_provider_id(&request.provider_id)?;
        let mut catalog = self
            .catalog
            .lock()
            .map_err(|_| ProviderCredentialError::StateUnavailable)?;
        let previous = catalog.clone();
        if !previous.bindings.contains_key(&request.provider_id) {
            return Err(ProviderCredentialError::InvalidRequest.into());
        }
        let affects_active =
            previous.active_provider_id.as_deref() == Some(request.provider_id.as_str());
        let mut next = previous.clone();
        next.bindings.remove(&request.provider_id);
        if affects_active {
            next.active_provider_id = None;
        }
        next.active_runtime_binding_id = if next.active_provider_id.is_some() {
            Some(new_runtime_binding_id()?)
        } else {
            None
        };
        self.commit_mutation(
            &mut catalog,
            previous,
            next,
            &request.provider_id,
            SecretMutation::Delete,
            coordinate,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn commit_mutation(
        &self,
        catalog: &mut ProviderCredentialCatalogFile,
        previous: ProviderCredentialCatalogFile,
        next: ProviderCredentialCatalogFile,
        provider_id: &str,
        secret_mutation: SecretMutation<'_>,
        coordinate: impl FnOnce(
            &ProviderRuntimeMutation<'_>,
        ) -> Result<(), ProviderRuntimeMutationFailure>,
    ) -> Result<ProviderCredentialCatalogView, ProviderCredentialMutationError> {
        let previous_runtime = active_runtime_for(self.secrets.as_ref(), &previous)?;
        let previous_secret = secret_snapshot(self.secrets.as_ref(), provider_id)?;
        let operation_id = new_operation_id()?;
        let backup_secret_key = format!("__crewon_provider_backup__{operation_id}");
        persist_secret_backup(self.secrets.as_ref(), &backup_secret_key, &previous_secret)?;
        let journal = ProviderCredentialMutationJournal {
            schema_version: MUTATION_JOURNAL_SCHEMA_VERSION.to_string(),
            operation_id: operation_id.clone(),
            runtime_binding_id: next.active_runtime_binding_id.clone(),
            provider_id: provider_id.to_string(),
            backup_secret_key,
            previous_secret_present: matches!(previous_secret, SecretSnapshot::Present(_)),
            previous_catalog: previous.clone(),
            candidate_catalog: next.clone(),
        };
        if write_secure_json(&self.journal_path(), &journal).is_err() {
            let _ = self.secrets.delete(&journal.backup_secret_key);
            return Err(ProviderCredentialError::CatalogInvalid.into());
        }
        if let Err(error) =
            apply_secret_mutation(self.secrets.as_ref(), provider_id, secret_mutation)
        {
            self.rollback_journal(&journal)?;
            return Err(error.into());
        }
        if let Err(error) = secret_snapshot(self.secrets.as_ref(), provider_id) {
            self.rollback_journal(&journal)?;
            return Err(error.into());
        }
        if let Err(error) = write_catalog(&self.catalog_path, &next) {
            if self.rollback_journal(&journal).is_err() {
                return Err(ProviderCredentialMutationError::Rollback);
            }
            return Err(error.into());
        }

        let candidate_runtime = match active_runtime_for(self.secrets.as_ref(), &next) {
            Ok(runtime) => runtime,
            Err(error) => {
                if self.rollback_journal(&journal).is_err() {
                    return Err(ProviderCredentialMutationError::Rollback);
                }
                return Err(error.into());
            }
        };
        let mutation = ProviderRuntimeMutation {
            operation_id: &operation_id,
            active_provider_id: next.active_provider_id.as_deref(),
            runtime_binding_id: next.active_runtime_binding_id.as_deref(),
            bindings: authority_bindings(&next),
            previous_runtime: previous_runtime.as_ref(),
            candidate_runtime: candidate_runtime.as_ref(),
        };
        if let Err(error) = coordinate(&mutation) {
            match error {
                ProviderRuntimeMutationFailure::BeforeCommit(code) => {
                    if self.rollback_journal(&journal).is_err() {
                        return Err(ProviderCredentialMutationError::Rollback);
                    }
                    return Err(ProviderCredentialMutationError::Runtime(code));
                }
                ProviderRuntimeMutationFailure::AfterCommit => {
                    *catalog = next;
                    return Err(ProviderCredentialMutationError::Rollback);
                }
            }
        }

        if self.cleanup_journal(&journal).is_err() {
            *catalog = next;
            return Err(ProviderCredentialMutationError::Rollback);
        }
        *catalog = next;
        Ok(catalog_view_for(self.secrets.as_ref(), catalog))
    }

    pub fn active_binding(&self) -> Result<Option<ActiveProviderBinding>, ProviderCredentialError> {
        let catalog = self
            .catalog
            .lock()
            .map_err(|_| ProviderCredentialError::StateUnavailable)?;
        active_binding_for(&catalog)
    }

    pub fn active_runtime(&self) -> Result<Option<ActiveProviderRuntime>, ProviderCredentialError> {
        let catalog = self
            .catalog
            .lock()
            .map_err(|_| ProviderCredentialError::StateUnavailable)?;
        active_runtime_for(self.secrets.as_ref(), &catalog)
    }

    pub(super) fn recover_with_coordinator(
        &self,
        recover: impl FnOnce(
            &ProviderCredentialRecovery<'_>,
        ) -> Result<ProviderCredentialRecoveryDisposition, &'static str>,
    ) -> Result<(), ProviderCredentialMutationError> {
        let Some(journal) =
            read_optional_secure_json::<ProviderCredentialMutationJournal>(&self.journal_path())?
        else {
            return Ok(());
        };
        validate_journal(&journal)?;
        let mut catalog = self
            .catalog
            .lock()
            .map_err(|_| ProviderCredentialError::StateUnavailable)?;
        let previous_runtime = previous_runtime_for_recovery(self.secrets.as_ref(), &journal)?;
        let recovery = ProviderCredentialRecovery {
            operation_id: &journal.operation_id,
            runtime_binding_id: journal.runtime_binding_id.as_deref(),
            previous_runtime: previous_runtime.as_ref(),
        };
        match recover(&recovery).map_err(ProviderCredentialMutationError::Runtime)? {
            ProviderCredentialRecoveryDisposition::KeepCandidate => {
                write_catalog(&self.catalog_path, &journal.candidate_catalog)?;
                *catalog = journal.candidate_catalog.clone();
                self.cleanup_journal(&journal)?;
            }
            ProviderCredentialRecoveryDisposition::RestorePrevious => {
                self.rollback_journal(&journal)?;
                *catalog = journal.previous_catalog.clone();
            }
        }
        Ok(())
    }

    fn journal_path(&self) -> PathBuf {
        self.catalog_path
            .with_file_name("provider-credential-mutation.v1.json")
    }

    fn rollback_journal(
        &self,
        journal: &ProviderCredentialMutationJournal,
    ) -> Result<(), ProviderCredentialMutationError> {
        restore_secret_from_backup(self.secrets.as_ref(), journal)
            .map_err(|_| ProviderCredentialMutationError::Rollback)?;
        write_catalog(&self.catalog_path, &journal.previous_catalog)
            .map_err(|_| ProviderCredentialMutationError::Rollback)?;
        self.cleanup_journal(journal)
    }

    fn cleanup_journal(
        &self,
        journal: &ProviderCredentialMutationJournal,
    ) -> Result<(), ProviderCredentialMutationError> {
        // The journal is the recovery authority. Remove it before its keychain
        // backup so a crash can only leave an unreachable backup orphan, never
        // a live journal whose required backup has already disappeared.
        remove_secure_file(&self.journal_path())
            .map_err(|_| ProviderCredentialMutationError::Rollback)?;
        self.secrets
            .delete(&journal.backup_secret_key)
            .map_err(|_| ProviderCredentialMutationError::Rollback)
    }
}

include!("provider_credentials_store_projection.rs");
