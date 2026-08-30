use serde::Deserialize;
use serde::Deserializer;
use serde::de;

use crate::SpanId;
use crate::TraceContext;
use crate::TraceId;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TraceContextWire {
    trace_id: TraceId,
    span_id: SpanId,
    parent_span_id: Option<SpanId>,
}

impl<'de> Deserialize<'de> for TraceContext {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = TraceContextWire::deserialize(deserializer)?;
        match wire.parent_span_id {
            Some(parent_span_id) => {
                Self::child(wire.trace_id, wire.span_id, parent_span_id).map_err(de::Error::custom)
            }
            None => Ok(Self::root(wire.trace_id, wire.span_id)),
        }
    }
}
