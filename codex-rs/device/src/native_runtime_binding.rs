use crate::NativeDeviceAdmissionError;
use crate::native_connection::require_opaque_id;

/// Current native runtime identity injected by trusted process composition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeDeviceRuntimeBinding {
    pub device_binding_id: String,
    pub runtime_binding_id: String,
}

impl NativeDeviceRuntimeBinding {
    pub fn new(
        device_binding_id: impl Into<String>,
        runtime_binding_id: impl Into<String>,
    ) -> Result<Self, NativeDeviceAdmissionError> {
        let binding = Self {
            device_binding_id: device_binding_id.into(),
            runtime_binding_id: runtime_binding_id.into(),
        };
        binding.validate()?;
        Ok(binding)
    }

    pub(crate) fn validate(&self) -> Result<(), NativeDeviceAdmissionError> {
        require_opaque_id(&self.device_binding_id, "device_binding_id_invalid")?;
        require_opaque_id(&self.runtime_binding_id, "device_runtime_binding_id_invalid")
    }
}
