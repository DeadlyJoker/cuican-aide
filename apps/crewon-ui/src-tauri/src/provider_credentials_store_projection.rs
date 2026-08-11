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
    let runtime_binding_id = catalog
        .active_runtime_binding_id
        .as_deref()
        .ok_or(ProviderCredentialError::CatalogInvalid)?;
    Ok(Some(active_binding(binding, runtime_binding_id)))
}

fn active_binding(binding: &ProviderBinding, runtime_binding_id: &str) -> ActiveProviderBinding {
    ActiveProviderBinding {
        credential_kind: binding.credential_kind,
        endpoint: binding.endpoint.clone(),
        environment_variable: binding.environment_variable.clone(),
        provider_id: binding.provider_id.clone(),
        runtime_binding_id: runtime_binding_id.to_string(),
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

fn new_operation_id() -> Result<String, ProviderCredentialError> {
    let random = getrandom::u64().map_err(|_| ProviderCredentialError::StateUnavailable)?;
    Ok(format!("provider-operation:{random:016x}"))
}

fn authority_bindings(
    catalog: &ProviderCredentialCatalogFile,
) -> Vec<ProviderRuntimeMutationBinding> {
    catalog
        .bindings
        .values()
        .map(|binding| ProviderRuntimeMutationBinding {
            credential_kind: binding.credential_kind,
            endpoint: binding.endpoint.clone(),
            environment_variable: binding.environment_variable.clone(),
            provider_id: binding.provider_id.clone(),
        })
        .collect()
}

fn persist_secret_backup(
    secrets: &dyn ProviderSecretStore,
    backup_key: &str,
    snapshot: &SecretSnapshot,
) -> Result<(), ProviderCredentialError> {
    match snapshot {
        SecretSnapshot::Missing => secrets.delete(backup_key).map_err(map_secret_store_error),
        SecretSnapshot::Present(secret) => secrets
            .set(backup_key, secret.as_str())
            .map_err(map_secret_store_error),
    }
}

fn restore_secret_from_backup(
    secrets: &dyn ProviderSecretStore,
    journal: &ProviderCredentialMutationJournal,
) -> Result<(), SecretStoreError> {
    if journal.previous_secret_present {
        let secret = secrets.get(&journal.backup_secret_key)?;
        secrets.set(&journal.provider_id, secret.as_str())
    } else {
        secrets.delete(&journal.provider_id)
    }
}

fn validate_journal(
    journal: &ProviderCredentialMutationJournal,
) -> Result<(), ProviderCredentialError> {
    validate_catalog(&journal.previous_catalog)?;
    validate_catalog(&journal.candidate_catalog)?;
    validate_provider_id(&journal.provider_id)?;
    if journal.schema_version != MUTATION_JOURNAL_SCHEMA_VERSION
        || journal.operation_id.is_empty()
        || journal.operation_id.len() > 128
        || journal.backup_secret_key
            != format!("__crewon_provider_backup__{}", journal.operation_id)
        || journal.runtime_binding_id != journal.candidate_catalog.active_runtime_binding_id
    {
        return Err(ProviderCredentialError::CatalogInvalid);
    }
    Ok(())
}

fn previous_runtime_for_recovery(
    secrets: &dyn ProviderSecretStore,
    journal: &ProviderCredentialMutationJournal,
) -> Result<Option<ActiveProviderRuntime>, ProviderCredentialError> {
    let Some(binding) = active_binding_for(&journal.previous_catalog)? else {
        return Ok(None);
    };
    let secret = match binding.credential_kind {
        ProviderCredentialKind::Keychain => {
            let key = if binding.provider_id == journal.provider_id {
                &journal.backup_secret_key
            } else {
                &binding.provider_id
            };
            Some(secrets.get(key).map_err(map_secret_store_error)?)
        }
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

fn map_secret_store_error(error: SecretStoreError) -> ProviderCredentialError {
    match error {
        SecretStoreError::Missing => ProviderCredentialError::CredentialMissing,
        SecretStoreError::Unavailable => ProviderCredentialError::CredentialStoreUnavailable,
    }
}
