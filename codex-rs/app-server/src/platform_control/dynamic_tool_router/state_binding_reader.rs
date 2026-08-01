use crewon_state::StateRuntime;

use super::ports::DynamicToolBindingReader;
use super::ports::DynamicToolPortError;

/// State-backed exact binding lookup used immediately before Provider tool admission.
pub(crate) struct StateDynamicToolBindingReader<'a> {
    state: &'a StateRuntime,
}

impl<'a> StateDynamicToolBindingReader<'a> {
    pub(crate) fn new(state: &'a StateRuntime) -> Self {
        Self { state }
    }
}

impl DynamicToolBindingReader for StateDynamicToolBindingReader<'_> {
    async fn read_binding(
        &self,
        binding_id: String,
    ) -> Result<Option<crewon_state::ProviderResourceBindingRecord>, DynamicToolPortError> {
        self.state
            .get_provider_resource_binding_record(&binding_id)
            .await
            .map_err(|_| DynamicToolPortError::Unavailable)
    }
}

impl std::fmt::Debug for StateDynamicToolBindingReader<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("StateDynamicToolBindingReader([REDACTED])")
    }
}
