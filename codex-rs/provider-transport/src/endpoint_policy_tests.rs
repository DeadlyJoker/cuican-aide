//! Endpoint policy behavior matrix preserved from the app-server implementation.

use std::collections::VecDeque;
use std::net::IpAddr;
use std::str::FromStr;
use std::sync::Mutex;

use super::*;
use pretty_assertions::assert_eq;

struct FakeEndpointResolver {
    answers: Mutex<VecDeque<Result<Vec<IpAddr>, ProviderEndpointPolicyError>>>,
}

impl FakeEndpointResolver {
    fn new(answers: impl IntoIterator<Item = Vec<IpAddr>>) -> Self {
        Self {
            answers: Mutex::new(answers.into_iter().map(Ok).collect()),
        }
    }
}

impl EndpointResolver for FakeEndpointResolver {
    async fn resolve(
        &self,
        _host: String,
        _port: u16,
    ) -> Result<Vec<IpAddr>, ProviderEndpointPolicyError> {
        self.answers
            .lock()
            .expect("resolver lock")
            .pop_front()
            .unwrap_or(Err(ProviderEndpointPolicyError::EmptyDnsResult))
    }
}

fn ip(raw: &str) -> IpAddr {
    IpAddr::from_str(raw).expect("valid IP address")
}

#[tokio::test]
async fn production_https_validation_returns_pinned_public_addresses() {
    let policy = ProviderEndpointPolicy::production();
    let resolver = FakeEndpointResolver::new([vec![ip("93.184.216.34")]]);

    let endpoint = policy
        .validate("https://provider.example/api", &resolver)
        .await
        .expect("public HTTPS endpoint");

    assert_eq!(endpoint.url().as_str(), "https://provider.example/api");
    assert_eq!(
        endpoint.socket_addrs(),
        &[SocketAddr::new(ip("93.184.216.34"), 443)]
    );
}

#[tokio::test]
async fn production_rejects_unsafe_url_and_address_classes() {
    let cases = [
        (
            "http://provider.example/api",
            vec![ip("93.184.216.34")],
            ProviderEndpointPolicyError::SchemeNotAllowed,
        ),
        (
            "https://127.0.0.1/api",
            Vec::new(),
            ProviderEndpointPolicyError::ForbiddenAddress,
        ),
        (
            "https://[::ffff:127.0.0.1]/api",
            Vec::new(),
            ProviderEndpointPolicyError::ForbiddenAddress,
        ),
        (
            "https://[fc00::1]/api",
            Vec::new(),
            ProviderEndpointPolicyError::ForbiddenAddress,
        ),
        (
            "https://provider.example/api",
            vec![ip("10.0.0.1")],
            ProviderEndpointPolicyError::ForbiddenAddress,
        ),
        (
            "https://provider.example/api",
            vec![ip("169.254.169.254")],
            ProviderEndpointPolicyError::ForbiddenAddress,
        ),
        (
            "https://provider.example/api",
            vec![ip("93.184.216.34"), ip("192.168.1.2")],
            ProviderEndpointPolicyError::ForbiddenAddress,
        ),
        (
            "https://provider.example/api",
            vec![ip("93.184.216.34"), ip("127.0.0.1")],
            ProviderEndpointPolicyError::MixedAddressClasses,
        ),
        (
            "https://metadata.google.internal/api",
            Vec::new(),
            ProviderEndpointPolicyError::MetadataHost,
        ),
        (
            "https://user:password@provider.example/api",
            Vec::new(),
            ProviderEndpointPolicyError::EmbeddedCredentials,
        ),
        (
            "https://provider.example/api?token=value",
            Vec::new(),
            ProviderEndpointPolicyError::QueryNotAllowed,
        ),
        (
            "https://provider.example/api#fragment",
            Vec::new(),
            ProviderEndpointPolicyError::FragmentNotAllowed,
        ),
    ];

    for (url, addresses, expected) in cases {
        let policy = ProviderEndpointPolicy::production();
        let resolver = FakeEndpointResolver::new([addresses]);
        assert_eq!(
            policy.validate(url, &resolver).await,
            Err(expected),
            "{url}"
        );
    }
}

#[tokio::test]
async fn system_resolver_uses_local_name_resolution_port() {
    let addresses = SystemEndpointResolver
        .resolve("localhost".to_string(), 80)
        .await
        .expect("localhost resolution");

    assert!(!addresses.is_empty());
    assert!(addresses.into_iter().all(|address| address.is_loopback()));
}

#[tokio::test]
async fn development_http_allows_loopback_but_not_private_networks() {
    let policy = ProviderEndpointPolicy::development_loopback();
    let loopback = FakeEndpointResolver::new([vec![ip("127.0.0.1")]]);
    let endpoint = policy
        .validate("http://localhost:8080/api", &loopback)
        .await
        .expect("development loopback");
    assert_eq!(
        endpoint.socket_addrs(),
        &[SocketAddr::new(ip("127.0.0.1"), 8080)]
    );

    let private = FakeEndpointResolver::new([vec![ip("192.168.1.10")]]);
    assert_eq!(
        policy.validate("http://provider.test/api", &private).await,
        Err(ProviderEndpointPolicyError::ForbiddenAddress)
    );
}

#[tokio::test]
async fn redirect_validation_rechecks_dns_and_rejects_rebinding_and_cross_origin() {
    let policy = ProviderEndpointPolicy::production();
    let resolver =
        FakeEndpointResolver::new([vec![ip("93.184.216.34")], vec![ip("169.254.169.254")]]);
    let current = policy
        .validate("https://provider.example/api", &resolver)
        .await
        .expect("initial endpoint");

    assert_eq!(
        policy
            .validate_redirect(
                ProviderRedirect {
                    current: &current,
                    location: "/next",
                    redirects_followed: 0,
                },
                &resolver,
            )
            .await,
        Err(ProviderEndpointPolicyError::ForbiddenAddress)
    );

    let unused = FakeEndpointResolver::new([]);
    assert_eq!(
        policy
            .validate_redirect(
                ProviderRedirect {
                    current: &current,
                    location: "https://other.example/next",
                    redirects_followed: 0,
                },
                &unused,
            )
            .await,
        Err(ProviderEndpointPolicyError::CrossOriginRedirect)
    );
    assert_eq!(
        policy
            .validate_redirect(
                ProviderRedirect {
                    current: &current,
                    location: "/next",
                    redirects_followed: policy.limits.max_redirects,
                },
                &unused,
            )
            .await,
        Err(ProviderEndpointPolicyError::RedirectLimitExceeded)
    );
}
