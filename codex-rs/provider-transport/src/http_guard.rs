use futures::StreamExt;
use reqwest::Method;
use reqwest::RequestBuilder;

use crate::endpoint_policy::ProviderEndpointPolicy;
use crate::endpoint_policy::ProviderEndpointPolicyError;
use crate::endpoint_policy::ValidatedProviderEndpoint;
use crate::endpoint_policy::parse_ip_literal;
use crate::endpoint_policy::same_origin;

pub struct PinnedProviderClient {
    client: reqwest::Client,
    endpoint: ValidatedProviderEndpoint,
    max_response_bytes: usize,
}

impl PinnedProviderClient {
    pub(crate) fn new(
        policy: ProviderEndpointPolicy,
        endpoint: ValidatedProviderEndpoint,
    ) -> Result<Self, ProviderEndpointPolicyError> {
        let host = endpoint
            .url
            .host_str()
            .ok_or(ProviderEndpointPolicyError::MissingHost)?;
        let builder = reqwest::Client::builder()
            .connect_timeout(policy.limits.connect_timeout)
            .timeout(policy.limits.request_timeout)
            .redirect(reqwest::redirect::Policy::none());
        let builder = if parse_ip_literal(host).is_some() {
            builder
        } else {
            builder.resolve_to_addrs(host, &endpoint.socket_addrs)
        };
        let client = builder
            .build()
            .map_err(|_| ProviderEndpointPolicyError::ClientConfiguration)?;
        Ok(Self {
            client,
            endpoint,
            max_response_bytes: policy.limits.max_response_bytes,
        })
    }

    pub fn request(
        &self,
        method: Method,
        relative_path: &str,
    ) -> Result<RequestBuilder, ProviderEndpointPolicyError> {
        let url = self
            .endpoint
            .url
            .join(relative_path)
            .map_err(|_| ProviderEndpointPolicyError::InvalidUrl)?;
        if !same_origin(&self.endpoint.url, &url) {
            return Err(ProviderEndpointPolicyError::CrossOriginRequest);
        }
        if url.query().is_some() {
            return Err(ProviderEndpointPolicyError::QueryNotAllowed);
        }
        if url.fragment().is_some() {
            return Err(ProviderEndpointPolicyError::FragmentNotAllowed);
        }
        Ok(self.client.request(method, url))
    }

    pub async fn read_bounded_body(
        &self,
        response: reqwest::Response,
    ) -> Result<Vec<u8>, ProviderEndpointPolicyError> {
        if response
            .content_length()
            .is_some_and(|length| length > self.max_response_bytes as u64)
        {
            return Err(ProviderEndpointPolicyError::ResponseTooLarge);
        }
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(classify_request_error)?;
            let next_len = body
                .len()
                .checked_add(chunk.len())
                .ok_or(ProviderEndpointPolicyError::ResponseTooLarge)?;
            if next_len > self.max_response_bytes {
                return Err(ProviderEndpointPolicyError::ResponseTooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }
}

pub fn classify_request_error(error: reqwest::Error) -> ProviderEndpointPolicyError {
    if error.is_timeout() {
        ProviderEndpointPolicyError::RequestTimeout
    } else {
        ProviderEndpointPolicyError::NetworkRequest
    }
}

#[cfg(test)]
#[path = "http_guard_tests.rs"]
mod tests;
