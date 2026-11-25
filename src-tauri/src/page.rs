//! Fetch a public web page for the reader.
//!
//! Mirrors `src/lib/read-page.functions.ts`: http(s) only, no credentials in
//! the URL, no private or local addresses (checked after DNS, and the checked
//! addresses are pinned for the request), manual redirects, a size cap, and a
//! timeout. Text extraction happens in the webview with the shared
//! `readableFromBody` helper, so both targets produce the same reading text.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use serde::Serialize;
use url::{Host, Url};

const MAX_BYTES: usize = 1_500_000;
const MAX_HOPS: usize = 4;
const TIMEOUT: Duration = Duration::from_secs(12);
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const BLOCKED: &str = "That address can't be read.";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchedPage {
    content_type: String,
    body: String,
}

fn is_private_v4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || a == 0
        || (a == 100 && (64..=127).contains(&b))
        || a >= 224
}

fn is_private_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_private_v4(v4);
    }
    let head = ip.segments()[0];
    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        || (head & 0xffc0) == 0xfe80 // link-local fe80::/10
        || (head & 0xfe00) == 0xfc00 // unique local fc00::/7
}

pub fn is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_private_v4(v4),
        IpAddr::V6(v6) => is_private_v6(v6),
    }
}

pub fn parse_public_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|_| "Enter a full link, including https://.".to_string())?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Only http and https links can be read.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("That link can't be read.".into());
    }
    match url.host() {
        None => return Err(BLOCKED.into()),
        Some(Host::Ipv4(ip)) if is_private_v4(ip) => return Err(BLOCKED.into()),
        Some(Host::Ipv6(ip)) if is_private_v6(ip) => return Err(BLOCKED.into()),
        Some(Host::Domain(d)) => {
            let d = d.to_ascii_lowercase();
            if d.is_empty()
                || d == "localhost"
                || d.ends_with(".localhost")
                || d.ends_with(".local")
                || d.ends_with(".internal")
            {
                return Err(BLOCKED.into());
            }
        }
        _ => {}
    }
    Ok(url)
}

/// Resolve the host and refuse if any address is private. Returns the
/// addresses so the request connects only to what was checked.
async fn public_addrs(url: &Url) -> Result<Vec<SocketAddr>, String> {
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs: Vec<SocketAddr> = match url.host() {
        Some(Host::Ipv4(ip)) => vec![SocketAddr::new(IpAddr::V4(ip), port)],
        Some(Host::Ipv6(ip)) => vec![SocketAddr::new(IpAddr::V6(ip), port)],
        Some(Host::Domain(d)) => tokio::net::lookup_host((d, port))
            .await
            .map_err(|_| "Could not find that site.".to_string())?
            .collect(),
        None => vec![],
    };
    if addrs.is_empty() || addrs.iter().any(|a| is_private(a.ip())) {
        return Err(BLOCKED.into());
    }
    Ok(addrs)
}

fn friendly(err: reqwest::Error) -> String {
    if err.is_timeout() {
        "The page took too long to respond.".into()
    } else {
        "Could not read that page.".into()
    }
}

#[tauri::command]
pub async fn fetch_page(url: String) -> Result<FetchedPage, String> {
    let mut current = parse_public_url(&url)?;
    for _ in 0..MAX_HOPS {
        let addrs = public_addrs(&current).await?;
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(TIMEOUT)
            .user_agent(USER_AGENT);
        if let Some(domain) = current.domain() {
            builder = builder.resolve_to_addrs(domain, &addrs);
        }
        let client = builder.build().map_err(|_| "Could not read that page.".to_string())?;
        let mut res = client
            .get(current.clone())
            .header("Accept", "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1")
            .send()
            .await
            .map_err(friendly)?;

        let status = res.status();
        if status.is_redirection() {
            let loc = res
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| "The page redirected nowhere.".to_string())?;
            let next = current.join(loc).map_err(|_| "The page redirected nowhere.".to_string())?;
            current = parse_public_url(next.as_str())?;
            continue;
        }
        if !status.is_success() {
            return Err(format!("The page returned {}.", status.as_u16()));
        }
        let content_type = res
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        let texty = ["text/", "xml", "json", "html"].iter().any(|t| content_type.contains(t));
        if !content_type.is_empty() && !texty {
            return Err("That link isn't a text page.".into());
        }

        let mut bytes: Vec<u8> = Vec::new();
        while let Some(chunk) = res.chunk().await.map_err(friendly)? {
            let room = MAX_BYTES - bytes.len();
            bytes.extend_from_slice(&chunk[..chunk.len().min(room)]);
            if bytes.len() >= MAX_BYTES {
                break;
            }
        }
        let body = String::from_utf8_lossy(&bytes).into_owned();
        return Ok(FetchedPage { content_type, body });
    }
    Err("That page redirected too many times.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_private_and_local_addresses() {
        for ip in [
            "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.1.1", "100.64.0.1", "0.0.0.0",
            "224.0.0.1", "::1", "fe80::1", "fd00::1", "::ffff:192.168.1.1",
        ] {
            assert!(is_private(ip.parse().unwrap()), "{ip} should be blocked");
        }
        for ip in ["93.184.216.34", "8.8.8.8", "2606:4700::1111"] {
            assert!(!is_private(ip.parse().unwrap()), "{ip} should be allowed");
        }
    }

    #[test]
    fn validates_urls() {
        assert!(parse_public_url("https://example.com/a").is_ok());
        assert!(parse_public_url("ftp://example.com").is_err());
        assert!(parse_public_url("https://user:pw@example.com").is_err());
        assert!(parse_public_url("http://localhost:8080").is_err());
        assert!(parse_public_url("http://printer.local").is_err());
        assert!(parse_public_url("http://192.168.0.10").is_err());
        assert!(parse_public_url("http://[::1]/").is_err());
        assert!(parse_public_url("not a url").is_err());
    }
}
