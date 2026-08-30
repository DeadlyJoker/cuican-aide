use std::collections::BTreeSet;
use std::fmt;
use std::future::Future;
use std::net::IpAddr;
use std::net::Ipv4Addr;
use std::net::Ipv6Addr;
use std::net::SocketAddr;
use std::net::ToSocketAddrs;
use std::time::Duration;

use reqwest::Url;

use crate::PinnedProviderClient;

const DEFAULT_MAX_REDIRECTS: u8 = 3;
const DEFAULT_MAX_RESPONSE_BYTES: usize = 1_000_000;
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProviderEndpointEnvironment {
    Production,
    DevelopmentLoopback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct ProviderEndpointLimits {
    pub(super) max_redirects: u8,
    pub(super) max_response_bytes: usize,
    pub(super) connect_timeout: Duration,
    pub(super) request_timeout: Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProviderEndpointPolicy {
    pub(super) environment: ProviderEndpointEnvironment,
    pub(super) limits: ProviderEndpointLimits,
}

impl ProviderEndpointPolicy {
    pub fn production() -> Self {
        Self::new(ProviderEndpointEnvironment::Production)
    }

    pub fn development_loopback() -> Self {
        Self::new(ProviderEndpointEnvironment::DevelopmentLoopback)
    }

    fn new(environment: ProviderEndpointEnvironment) -> Self {
        Self {
            environment,
            limits: ProviderEndpointLimits {
                max_redirects: DEFAULT_MAX_REDIRECTS,
                max_response_bytes: DEFAULT_MAX_RESPONSE_BYTES,
                connect_timeout: DEFAULT_CONNECT_TIMEOUT,
                request_timeout: DEFAULT_REQUEST_TIMEOUT,
            },
        }
    }

    pub async fn validate<R>(
        &self,
        raw_url: &str,
        resolver: &R,
    ) -> Result<ValidatedProviderEndpoint, ProviderEndpointPolicyError>
    where
        R: EndpointResolver,
    {
        let url = Url::parse(raw_url).map_err(|_| ProviderEndpointPolicyError::InvalidUrl)?;
        self.validate_url(url, resolver).await
    }

    pub async fn validate_redirect<R>(
        &self,
        redirect: ProviderRedirect<'_>,
        resolver: &R,
    ) -> Result<ValidatedProviderEndpoint, ProviderEndpointPolicyError>
    where
        R: EndpointResolver,
    {
        if redirect.redirects_followed >= self.limits.max_redirects {
            return Err(ProviderEndpointPolicyError::RedirectLimitExceeded);
        }
        let url = redirect
            .current
            .url
            .join(redirect.location)
            .map_err(|_| ProviderEndpointPolicyError::InvalidUrl)?;
        if !same_origin(&redirect.current.url, &url) {
            return Err(ProviderEndpointPolicyError::CrossOriginRedirect);
        }
        self.validate_url(url, resolver).await
    }

    pub fn pinned_client(
        &self,
        endpoint: ValidatedProviderEndpoint,
    ) -> Result<PinnedProviderClient, ProviderEndpointPolicyError> {
        PinnedProviderClient::new(*self, endpoint)
    }

    async fn validate_url<R>(
        &self,
        url: Url,
        resolver: &R,
    ) -> Result<ValidatedProviderEndpoint, ProviderEndpointPolicyError>
    where
        R: EndpointResolver,
    {
        if !url.username().is_empty() || url.password().is_some() {
            return Err(ProviderEndpointPolicyError::EmbeddedCredentials);
        }
        if url.query().is_some() {
            return Err(ProviderEndpointPolicyError::QueryNotAllowed);
        }
        if url.fragment().is_some() {
            return Err(ProviderEndpointPolicyError::FragmentNotAllowed);
        }
        let host = url
            .host_str()
            .ok_or(ProviderEndpointPolicyError::MissingHost)?;
        if is_metadata_host(host) {
            return Err(ProviderEndpointPolicyError::MetadataHost);
        }
        let port = url
            .port_or_known_default()
            .ok_or(ProviderEndpointPolicyError::MissingPort)?;
        let addresses = match parse_ip_literal(host) {
            Some(address) => vec![address],
            None => resolver.resolve(host.to_string(), port).await?,
        };
        let addresses = addresses.into_iter().collect::<BTreeSet<_>>();
        if addresses.is_empty() {
            return Err(ProviderEndpointPolicyError::EmptyDnsResult);
        }
        let address_mode = classify_addresses(&addresses)?;
        match (self.environment, address_mode) {
            (ProviderEndpointEnvironment::Production, AddressMode::Loopback) => {
                return Err(ProviderEndpointPolicyError::ForbiddenAddress);
            }
            (ProviderEndpointEnvironment::Production, AddressMode::Public)
            | (ProviderEndpointEnvironment::DevelopmentLoopback, AddressMode::Public)
                if url.scheme() != "https" =>
            {
                return Err(ProviderEndpointPolicyError::SchemeNotAllowed);
            }
            (ProviderEndpointEnvironment::DevelopmentLoopback, AddressMode::Loopback)
                if !matches!(url.scheme(), "https" | "http") =>
            {
                return Err(ProviderEndpointPolicyError::SchemeNotAllowed);
            }
            _ => {}
        }
        let socket_addrs = addresses
            .into_iter()
            .map(|address| SocketAddr::new(address, port))
            .collect();
        Ok(ValidatedProviderEndpoint { url, socket_addrs })
    }
}

/// DNS resolution port used before every Provider request origin or redirect hop.
///
/// Implementations must return every address that may be selected for the connection. Callers pin
/// the returned set into the HTTP client so a later resolver lookup cannot bypass policy checks.
pub trait EndpointResolver: Send + Sync {
    fn resolve(
        &self,
        host: String,
        port: u16,
    ) -> impl Future<Output = Result<Vec<IpAddr>, ProviderEndpointPolicyError>> + Send;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SystemEndpointResolver;

impl EndpointResolver for SystemEndpointResolver {
    async fn resolve(
        &self,
        host: String,
        port: u16,
    ) -> Result<Vec<IpAddr>, ProviderEndpointPolicyError> {
        tokio::task::spawn_blocking(move || {
            (host.as_str(), port)
                .to_socket_addrs()
                .map(|addresses| addresses.map(|address| address.ip()).collect::<Vec<_>>())
        })
        .await
        .map_err(|_| ProviderEndpointPolicyError::DnsResolution)?
        .map_err(|_| ProviderEndpointPolicyError::DnsResolution)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedProviderEndpoint {
    pub(super) url: Url,
    pub(super) socket_addrs: Vec<SocketAddr>,
}

impl ValidatedProviderEndpoint {
    pub fn url(&self) -> &Url {
        &self.url
    }

    pub fn socket_addrs(&self) -> &[SocketAddr] {
        &self.socket_addrs
    }
}

pub struct ProviderRedirect<'a> {
    pub current: &'a ValidatedProviderEndpoint,
    pub location: &'a str,
    pub redirects_followed: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderEndpointPolicyError {
    InvalidUrl,
    EmbeddedCredentials,
    QueryNotAllowed,
    FragmentNotAllowed,
    MissingHost,
    MissingPort,
    MetadataHost,
    DnsResolution,
    EmptyDnsResult,
    ForbiddenAddress,
    MixedAddressClasses,
    SchemeNotAllowed,
    RedirectLimitExceeded,
    CrossOriginRedirect,
    CrossOriginRequest,
    ClientConfiguration,
    RequestTimeout,
    NetworkRequest,
    ResponseTooLarge,
}

impl fmt::Display for ProviderEndpointPolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidUrl => "invalid provider endpoint",
            Self::EmbeddedCredentials => "provider endpoint must not contain credentials",
            Self::QueryNotAllowed => "provider endpoint query is not allowed",
            Self::FragmentNotAllowed => "provider endpoint fragment is not allowed",
            Self::MissingHost => "provider endpoint host is required",
            Self::MissingPort => "provider endpoint port is required",
            Self::MetadataHost => "provider endpoint metadata host is forbidden",
            Self::DnsResolution => "provider endpoint DNS resolution failed",
            Self::EmptyDnsResult => "provider endpoint DNS result is empty",
            Self::ForbiddenAddress => "provider endpoint address is forbidden",
            Self::MixedAddressClasses => "provider endpoint DNS result mixes address classes",
            Self::SchemeNotAllowed => "provider endpoint scheme is not allowed",
            Self::RedirectLimitExceeded => "provider endpoint redirect limit exceeded",
            Self::CrossOriginRedirect => "provider endpoint cross-origin redirect is forbidden",
            Self::CrossOriginRequest => "provider request must use the validated origin",
            Self::ClientConfiguration => "provider HTTP client configuration failed",
            Self::RequestTimeout => "provider request timed out",
            Self::NetworkRequest => "provider network request failed",
            Self::ResponseTooLarge => "provider response exceeds the configured limit",
        })
    }
}

impl std::error::Error for ProviderEndpointPolicyError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AddressMode {
    Public,
    Loopback,
}

fn classify_addresses(
    addresses: &BTreeSet<IpAddr>,
) -> Result<AddressMode, ProviderEndpointPolicyError> {
    let modes = addresses
        .iter()
        .map(|address| match address {
            IpAddr::V4(address) => classify_ipv4(*address),
            IpAddr::V6(address) => classify_ipv6(*address),
        })
        .collect::<BTreeSet<_>>();
    if modes.contains(&AddressClass::Forbidden) {
        return Err(ProviderEndpointPolicyError::ForbiddenAddress);
    }
    if modes.len() != 1 {
        return Err(ProviderEndpointPolicyError::MixedAddressClasses);
    }
    if modes.contains(&AddressClass::Public) {
        Ok(AddressMode::Public)
    } else if modes.contains(&AddressClass::Loopback) {
        Ok(AddressMode::Loopback)
    } else {
        Err(ProviderEndpointPolicyError::ForbiddenAddress)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum AddressClass {
    Public,
    Loopback,
    Forbidden,
}

fn classify_ipv4(address: Ipv4Addr) -> AddressClass {
    if address.is_loopback() {
        AddressClass::Loopback
    } else if is_non_global_ipv4(address) {
        AddressClass::Forbidden
    } else {
        AddressClass::Public
    }
}

fn classify_ipv6(address: Ipv6Addr) -> AddressClass {
    if address.is_loopback() {
        return AddressClass::Loopback;
    }
    if let Some(embedded) = address.to_ipv4() {
        return classify_ipv4(embedded);
    }
    if is_non_global_ipv6(address) {
        AddressClass::Forbidden
    } else {
        AddressClass::Public
    }
}

fn is_non_global_ipv4(address: Ipv4Addr) -> bool {
    let [first, second, third, fourth] = address.octets();
    first == 0
        || first == 10
        || (first == 100 && (64..=127).contains(&second))
        || first == 127
        || (first == 169 && second == 254)
        || (first == 172 && (16..=31).contains(&second))
        || (first == 192 && second == 0 && third == 0 && !matches!(fourth, 9 | 10))
        || (first == 192 && second == 0 && third == 2)
        || (first == 192 && second == 88 && third == 99)
        || (first == 192 && second == 168)
        || (first == 198 && matches!(second, 18 | 19))
        || (first == 198 && second == 51 && third == 100)
        || (first == 203 && second == 0 && third == 113)
        || first >= 224
}

fn is_non_global_ipv6(address: Ipv6Addr) -> bool {
    let segments = address.segments();
    address.is_unspecified()
        || address.is_multicast()
        || address.is_unique_local()
        || address.is_unicast_link_local()
        || (segments[0] & 0xffc0) == 0xfec0
        || (segments[0] == 0x0064 && segments[1] == 0xff9b && segments[2] == 0x0001)
        || (segments[0] == 0x0100 && segments[1] == 0 && segments[2] == 0 && segments[3] == 0)
        || (segments[0] == 0x2001 && segments[1] <= 0x01ff)
        || (segments[0] == 0x2001 && segments[1] == 0x0db8)
        || (segments[0] & 0xfff0) == 0x3ff0
}

pub(super) fn same_origin(left: &Url, right: &Url) -> bool {
    left.scheme() == right.scheme()
        && left.host_str() == right.host_str()
        && left.port_or_known_default() == right.port_or_known_default()
}

fn is_metadata_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    matches!(
        host.as_str(),
        "metadata"
            | "metadata.internal"
            | "metadata.google.internal"
            | "instance-data"
            | "instance-data.ec2.internal"
    ) || host.ends_with(".metadata.google.internal")
}

pub(super) fn parse_ip_literal(host: &str) -> Option<IpAddr> {
    host.strip_prefix('[')
        .and_then(|host| host.strip_suffix(']'))
        .unwrap_or(host)
        .parse()
        .ok()
}

#[cfg(test)]
#[path = "endpoint_policy_tests.rs"]
mod tests;
