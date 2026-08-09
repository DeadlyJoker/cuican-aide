use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use zeroize::Zeroizing;

#[path = "provider_credentials_catalog_io.rs"]
mod catalog_io;

use self::catalog_io::read_catalog;
pub(super) use self::catalog_io::restrict_directory;
use self::catalog_io::write_catalog;

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
use super::ProviderCredentialTargetRequest;
use super::ProviderCredentialUpsertRequest;
use super::ProviderSecretStore;
use super::SecretStoreError;

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
        let catalog = read_catalog(&catalog_path)?;
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

    pub(super) fn upsert_with_reload(
        &self,
        request: &ProviderCredentialUpsertRequest,
        reload: impl FnOnce(
            Option<&ActiveProviderRuntime>,
            Option<&ActiveProviderRuntime>,
        ) -> Result<(), &'static str>,
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
        let affects_active = previous.active_provider_id.as_deref()
            == Some(binding.provider_id.as_str())
            || request.activate;
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
            affects_active,
            reload,
        )
    }

    pub(super) fn activate_with_reload(
        &self,
        request: &ProviderCredentialTargetRequest,
        reload: impl FnOnce(
            Option<&ActiveProviderRuntime>,
            Option<&ActiveProviderRuntime>,
        ) -> Result<(), &'static str>,
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
        self.commit_mutation(
            &mut catalog,
            previous,
            next,
            &request.provider_id,
            SecretMutation::Keep,
            /*affects_active*/ true,
            reload,
        )
    }

    #[cfg(test)]
    pub(super) fn delete(
        &self,
        request: &ProviderCredentialTargetRequest,
    ) -> Result<ProviderCredentialCatalogView, ProviderCredentialMutationError> {
        self.delete_with_reload(request, |_, _| Ok(()))
    }

    pub(super) fn delete_with_reload(
        &self,
        request: &ProviderCredentialTargetRequest,
        reload: impl FnOnce(
            Option<&ActiveProviderRuntime>,
            Option<&ActiveProviderRuntime>,
        ) -> Result<(), &'static str>,
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
        self.commit_mutation(
            &mut catalog,
            previous,
            next,
            &request.provider_id,
            SecretMutation::Delete,
            affects_active,
            reload,
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
        affects_active: bool,
        reload: impl FnOnce(
            Option<&ActiveProviderRuntime>,
            Option<&ActiveProviderRuntime>,
        ) -> Result<(), &'static str>,
    ) -> Result<ProviderCredentialCatalogView, ProviderCredentialMutationError> {
        let previous_runtime = if affects_active {
            active_runtime_for(self.secrets.as_ref(), &previous)?
        } else {
            None
        };
        let previous_secret = secret_snapshot(self.secrets.as_ref(), provider_id)?;
        apply_secret_mutation(self.secrets.as_ref(), provider_id, secret_mutation)?;
        let next_secret = match secret_snapshot(self.secrets.as_ref(), provider_id) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                restore_secret(self.secrets.as_ref(), provider_id, previous_secret)
                    .map_err(|_| ProviderCredentialMutationError::Rollback)?;
                return Err(error.into());
            }
        };
        let had_catalog_file = self.catalog_path.exists();
        if let Err(error) = write_catalog(&self.catalog_path, &next) {
            let catalog_may_have_changed = had_catalog_file || self.catalog_path.exists();
            if restore_secret(self.secrets.as_ref(), provider_id, previous_secret).is_err()
                || (catalog_may_have_changed
                    && write_catalog(&self.catalog_path, &previous).is_err())
            {
                return Err(ProviderCredentialMutationError::Rollback);
            }
            return Err(error.into());
        }

        if affects_active {
            let candidate_runtime = match active_runtime_for(self.secrets.as_ref(), &next) {
                Ok(runtime) => runtime,
                Err(error) => {
                    if restore_secret(self.secrets.as_ref(), provider_id, previous_secret).is_err()
                        || write_catalog(&self.catalog_path, &previous).is_err()
                    {
                        let _ = restore_secret(self.secrets.as_ref(), provider_id, next_secret);
                        return Err(ProviderCredentialMutationError::Rollback);
                    }
                    return Err(error.into());
                }
            };
            if let Err(code) = reload(previous_runtime.as_ref(), candidate_runtime.as_ref()) {
                if restore_secret(self.secrets.as_ref(), provider_id, previous_secret).is_err()
                    || write_catalog(&self.catalog_path, &previous).is_err()
                {
                    let _ = restore_secret(self.secrets.as_ref(), provider_id, next_secret);
                    return Err(ProviderCredentialMutationError::Rollback);
                }
                return Err(ProviderCredentialMutationError::Runtime(code));
            }
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
}

fn catalog_view_for(
    secrets: &dyn ProviderSecretStore,
    catalog: &ProviderCredentialCatalogFile,
) -> ProviderCredentialCatalogView {
    let bindings = catalog
        .bindings
        .values()
        .map(|binding| ProviderCredentialBindingView {
            credential_available: credential_available(secrets, binding),
            credential_kind: binding.credential_kind,
            endpoint: binding.endpoint.clone(),
            environment_variable: binding.environment_variable.clone(),
            is_active: catalog.active_provider_id.as_deref() == Some(binding.provider_id.as_str()),
            provider_id: binding.provider_id.clone(),
        })
        .collect();
    ProviderCredentialCatalogView {
        active_provider_id: catalog.active_provider_id.clone(),
        bindings,
    }
}

fn active_binding_for(
    catalog: &ProviderCredentialCatalogFile,
) -> Result<Option<ActiveProviderBinding>, ProviderCredentialError> {
    let Some(provider_id) = catalog.active_provider_id.as_deref() else {
        return Ok(None);
    };
    let binding = catalog
        .bindings
        .get(provider_id)
        .ok_or(ProviderCredentialError::CatalogInvalid)?;
    Ok(Some(active_binding(binding)))
}

fn active_binding(binding: &ProviderBinding) -> ActiveProviderBinding {
    ActiveProviderBinding {
        credential_kind: binding.credential_kind,
        endpoint: binding.endpoint.clone(),
        environment_variable: binding.environment_variable.clone(),
        provider_id: binding.provider_id.clone(),
    }
}

fn active_runtime_for(
    secrets: &dyn ProviderSecretStore,
    catalog: &ProviderCredentialCatalogFile,
) -> Result<Option<ActiveProviderRuntime>, ProviderCredentialError> {
    let Some(binding) = active_binding_for(catalog)? else {
        return Ok(None);
    };
    let secret = match binding.credential_kind {
        ProviderCredentialKind::Keychain => Some(
            secrets
                .get(&binding.provider_id)
                .map_err(map_secret_store_error)?,
        ),
        ProviderCredentialKind::Environment => {
            let variable = binding
                .environment_variable
                .as_deref()
                .ok_or(ProviderCredentialError::CatalogInvalid)?;
            Some(Zeroizing::new(
                std::env::var(variable).map_err(|_| ProviderCredentialError::CredentialMissing)?,
            ))
        }
        ProviderCredentialKind::None => None,
    };
    Ok(Some(ActiveProviderRuntime { binding, secret }))
}

fn credential_available(secrets: &dyn ProviderSecretStore, binding: &ProviderBinding) -> bool {
    match binding.credential_kind {
        ProviderCredentialKind::Environment => binding
            .environment_variable
            .as_ref()
            .is_some_and(|name| std::env::var_os(name).is_some()),
        ProviderCredentialKind::Keychain => secrets.get(&binding.provider_id).is_ok(),
        ProviderCredentialKind::None => true,
    }
}

fn require_credential_available(
    secrets: &dyn ProviderSecretStore,
    binding: &ProviderBinding,
) -> Result<(), ProviderCredentialError> {
    if credential_available(secrets, binding) {
        Ok(())
    } else {
        Err(ProviderCredentialError::CredentialMissing)
    }
}

fn secret_snapshot(
    secrets: &dyn ProviderSecretStore,
    provider_id: &str,
) -> Result<SecretSnapshot, ProviderCredentialError> {
    match secrets.get(provider_id) {
        Ok(secret) => Ok(SecretSnapshot::Present(secret)),
        Err(SecretStoreError::Missing) => Ok(SecretSnapshot::Missing),
        Err(SecretStoreError::Unavailable) => {
            Err(ProviderCredentialError::CredentialStoreUnavailable)
        }
    }
}

fn apply_secret_mutation(
    secrets: &dyn ProviderSecretStore,
    provider_id: &str,
    mutation: SecretMutation<'_>,
) -> Result<(), ProviderCredentialError> {
    match mutation {
        SecretMutation::Delete => secrets.delete(provider_id).map_err(map_secret_store_error),
        SecretMutation::Keep => Ok(()),
        SecretMutation::Require => {
            let secret = secrets.get(provider_id).map_err(map_secret_store_error)?;
            drop(secret);
            Ok(())
        }
        SecretMutation::Set(secret) => secrets
            .set(provider_id, secret)
            .map_err(map_secret_store_error),
    }
}

fn restore_secret(
    secrets: &dyn ProviderSecretStore,
    provider_id: &str,
    snapshot: SecretSnapshot,
) -> Result<(), SecretStoreError> {
    match snapshot {
        SecretSnapshot::Missing => secrets.delete(provider_id),
        SecretSnapshot::Present(secret) => secrets.set(provider_id, secret.as_str()),
    }
}

fn map_secret_store_error(error: SecretStoreError) -> ProviderCredentialError {
    match error {
        SecretStoreError::Missing => ProviderCredentialError::CredentialMissing,
        SecretStoreError::Unavailable => ProviderCredentialError::CredentialStoreUnavailable,
    }
}
