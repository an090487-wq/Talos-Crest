//! Optional GitHub integration. Everything here is opt-in: Talos makes no
//! network request until the user opens the GitHub Observatory tab and asks
//! for data. The personal access token is encrypted at rest with a locally
//! generated key and both files are written with owner-only permissions on
//! Unix; the local editor, marketplace and Observatory analysis remain fully
//! offline.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chacha20poly1305::{
    aead::{Aead, Payload},
    ChaCha20Poly1305, KeyInit, Nonce,
};
use serde_json::Value;

use crate::config_dir;

const API_ROOT: &str = "https://api.github.com";
const KEY_FILE: &str = "github-key.bin";
const TOKEN_FILE: &str = "github-token.bin";
const USER_AGENT: &str = "Talos-Crest/0.1.0";
const TIMEOUT_SECS: u64 = 20;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenStatus {
    configured: bool,
    masked: String,
}

fn github_dir() -> std::path::PathBuf {
    config_dir().join("github")
}

fn key_path() -> std::path::PathBuf {
    github_dir().join(KEY_FILE)
}

fn token_path() -> std::path::PathBuf {
    github_dir().join(TOKEN_FILE)
}

#[cfg(unix)]
fn restrict_file(path: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("could not protect {}: {e}", path.display()))
}

#[cfg(not(unix))]
fn restrict_file(_path: &std::path::Path) -> Result<(), String> {
    // The config directory is already inside the user profile on Windows and
    // macOS. Keeping the helper keeps the write path identical everywhere.
    Ok(())
}

fn random_bytes<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes)
        .map_err(|e| format!("could not generate local key material: {e}"))?;
    Ok(bytes)
}

fn load_or_create_key() -> Result<[u8; 32], String> {
    let path = key_path();
    if path.exists() {
        let encoded = std::fs::read_to_string(&path)
            .map_err(|e| format!("could not read local GitHub key: {e}"))?;
        let raw = STANDARD
            .decode(encoded.trim())
            .map_err(|_| "the local GitHub key is invalid".to_string())?;
        return raw
            .as_slice()
            .try_into()
            .map_err(|_| "the local GitHub key is invalid".to_string());
    }
    let key = random_bytes::<32>()?;
    std::fs::create_dir_all(github_dir())
        .map_err(|e| format!("could not create GitHub config directory: {e}"))?;
    std::fs::write(&path, STANDARD.encode(key))
        .map_err(|e| format!("could not write local GitHub key: {e}"))?;
    restrict_file(&path)?;
    Ok(key)
}

pub(crate) fn read_token() -> Option<String> {
    let encrypted = std::fs::read(token_path()).ok()?;
    let encoded = std::fs::read_to_string(key_path()).ok()?;
    let key: [u8; 32] = STANDARD
        .decode(encoded.trim())
        .ok()?
        .as_slice()
        .try_into()
        .ok()?;
    if encrypted.len() < 12 {
        return None;
    }
    let (nonce, ciphertext) = encrypted.split_at(12);
    let cipher = ChaCha20Poly1305::new_from_slice(&key).ok()?;
    let plain = cipher
        .decrypt(Nonce::from_slice(nonce), Payload::from(ciphertext))
        .ok()?;
    String::from_utf8(plain).ok()
}

/// Validate a token before it is stored. GitHub classic tokens start with
/// `ghp_` and fine-grained tokens with `github_pat_`; a small amount of slack
/// is left for future GitHub prefixes without accepting arbitrary strings.
pub(crate) fn valid_token(token: &str) -> bool {
    let token = token.trim();
    if token.len() < 20 || token.len() > 256 || token.chars().any(char::is_whitespace) {
        return false;
    }
    token.starts_with("ghp_") || token.starts_with("github_pat_") || token.starts_with("gho_")
}

fn masked_token(token: &str) -> String {
    let tail = token
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    format!("••••{tail}")
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ApiRoute {
    User,
    UserRepos,
    Repo,
    RepoIssues,
    RepoPulls,
    RepoBranches,
    RepoCommits,
    RepoIssue,
    RepoPull,
    IssueComments,
    PullComments,
    PullReviews,
    PullMerge,
}

/// Accept only GitHub REST paths Talos actually renders. This keeps the
/// renderer from turning the API helper into a generic outbound request tool.
fn api_route(path: &str) -> Option<ApiRoute> {
    let (path, query) = match path.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (path, None),
    };
    if !path.starts_with('/') || path.contains("//") || path.contains('@') || !valid_query(query) {
        return None;
    }
    let segments: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    match segments.as_slice() {
        ["user"] => Some(ApiRoute::User),
        ["user", "repos"] => Some(ApiRoute::UserRepos),
        ["repos", owner, repo] if valid_repo_part(owner) && valid_repo_part(repo) => {
            Some(ApiRoute::Repo)
        }
        ["repos", owner, repo, tail @ ..] if valid_repo_part(owner) && valid_repo_part(repo) => {
            match tail {
                ["issues"] => Some(ApiRoute::RepoIssues),
                ["pulls"] => Some(ApiRoute::RepoPulls),
                ["branches"] => Some(ApiRoute::RepoBranches),
                ["commits"] => Some(ApiRoute::RepoCommits),
                ["issues", number] if is_number(number) => Some(ApiRoute::RepoIssue),
                ["pulls", number] if is_number(number) => Some(ApiRoute::RepoPull),
                ["issues", number, "comments"] if is_number(number) => {
                    Some(ApiRoute::IssueComments)
                }
                ["pulls", number, "comments"] if is_number(number) => Some(ApiRoute::PullComments),
                ["pulls", number, "reviews"] if is_number(number) => Some(ApiRoute::PullReviews),
                ["pulls", number, "merge"] if is_number(number) => Some(ApiRoute::PullMerge),
                _ => None,
            }
        }
        _ => None,
    }
}

fn valid_query(query: Option<&str>) -> bool {
    let Some(query) = query else {
        return true;
    };
    if query.is_empty()
        || query.len() > 200
        || query
            .chars()
            .any(|c| c.is_control() || c == '\\' || c == '@')
    {
        return false;
    }
    if query.to_ascii_lowercase().contains("%2f") {
        return false;
    }
    let mut seen = std::collections::HashSet::new();
    query.split('&').all(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        matches!(key, "per_page" | "state" | "sort" | "page")
            && !value.is_empty()
            && value.len() <= 40
            && value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ','))
            && seen.insert(key)
    })
}

fn route_allows_method(route: ApiRoute, method: &str) -> bool {
    match route {
        ApiRoute::User
        | ApiRoute::Repo
        | ApiRoute::RepoBranches
        | ApiRoute::RepoCommits
        | ApiRoute::PullReviews => method == "GET",
        ApiRoute::UserRepos
        | ApiRoute::RepoIssues
        | ApiRoute::RepoPulls
        | ApiRoute::IssueComments
        | ApiRoute::PullComments => matches!(method, "GET" | "POST"),
        ApiRoute::RepoIssue | ApiRoute::RepoPull => matches!(method, "GET" | "PATCH"),
        ApiRoute::PullMerge => method == "PUT",
    }
}

fn valid_repo_part(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value != "."
        && value != ".."
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

fn is_number(value: &str) -> bool {
    !value.is_empty() && value.len() <= 10 && value.chars().all(|c| c.is_ascii_digit())
}

fn api_error(status: reqwest::StatusCode, body: &str) -> String {
    let message = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| value.get("message")?.as_str().map(str::to_owned))
        .unwrap_or_else(|| body.chars().take(200).collect());
    match status.as_u16() {
        401 => "GitHub rejected this token. Generate a new personal access token.".to_string(),
        403 if message.to_lowercase().contains("rate limit") => {
            "GitHub API rate limit reached. Try again later.".to_string()
        }
        403 => format!("GitHub denied access: {message}"),
        404 => format!("Not found on GitHub: {message}"),
        422 => format!("GitHub rejected the request: {message}"),
        _ => format!("GitHub returned HTTP {status}: {message}"),
    }
}

#[tauri::command]
pub(crate) fn github_token_status() -> TokenStatus {
    let token = read_token();
    TokenStatus {
        configured: token.is_some(),
        masked: token.map(|value| masked_token(&value)).unwrap_or_default(),
    }
}

#[tauri::command]
pub(crate) fn github_set_token(token: String) -> Result<(), String> {
    let token = token.trim().to_owned();
    if !valid_token(&token) {
        return Err(
            "Enter a GitHub personal access token starting with ghp_ or github_pat_.".to_string(),
        );
    }
    let key = load_or_create_key()?;
    let nonce = random_bytes::<12>()?;
    let cipher = ChaCha20Poly1305::new_from_slice(&key)
        .map_err(|_| "could not initialize local GitHub encryption".to_string())?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload::from(token.as_bytes()))
        .map_err(|_| "could not encrypt the GitHub token".to_string())?;
    let mut blob = nonce.to_vec();
    blob.extend_from_slice(&ciphertext);
    std::fs::create_dir_all(github_dir())
        .map_err(|e| format!("could not create GitHub config directory: {e}"))?;
    let path = token_path();
    std::fs::write(&path, blob).map_err(|e| format!("could not save the GitHub token: {e}"))?;
    restrict_file(&path)
}

#[tauri::command]
pub(crate) fn github_clear_token() -> Result<(), String> {
    match std::fs::remove_file(token_path()) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("could not remove the GitHub token: {error}")),
    }
}

#[tauri::command]
pub(crate) async fn github_api(
    method: String,
    path: String,
    body: Option<Value>,
) -> Result<Value, String> {
    let token = read_token().ok_or_else(|| "No GitHub token is configured.".to_string())?;
    let route = api_route(&path).ok_or_else(|| "Unsupported GitHub API path.".to_string())?;
    if !route_allows_method(route, &method) {
        return Err("Unsupported GitHub request method for this action.".to_string());
    }
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("could not create GitHub client: {e}"))?;
    let mut request = client
        .request(
            method
                .parse()
                .map_err(|_| "Unsupported GitHub request method.".to_string())?,
            format!("{API_ROOT}{path}"),
        )
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28");
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|e| {
        format!(
            "GitHub is unreachable: {e}. Talos works offline; only this tab needs a connection."
        )
    })?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("could not read GitHub response: {e}"))?;
    if !status.is_success() {
        return Err(api_error(status, &text));
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|e| format!("could not parse GitHub response: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_validation_rejects_junk_and_accepts_supported_prefixes() {
        assert!(valid_token(&format!("ghp_{}", "a".repeat(40))));
        assert!(valid_token(&format!("github_pat_{}", "a".repeat(40))));
        assert!(!valid_token("short"));
        assert!(!valid_token(&format!("ghp_{} with spaces", "a".repeat(40))));
        assert!(!valid_token("javascript:alert(1)"));
    }

    #[test]
    fn api_paths_are_restricted_to_the_rendered_github_features() {
        assert!(api_route("/user").is_some());
        assert!(api_route("/user/repos?per_page=50&state=all").is_some());
        assert!(api_route("/repos/acme/talos/issues?state=open").is_some());
        assert!(api_route("/repos/acme/talos/issues/42/comments?per_page=100").is_some());
        assert!(api_route("/repos/acme/talos/pulls/7/reviews").is_some());
        assert!(api_route("/repos/acme/talos/pulls/7/merge").is_some());
        assert!(api_route("https://example.com/user").is_none());
        assert!(api_route("/repos/acme/talos/actions").is_none());
        assert!(api_route("/repos/acme/talos/issues/../../secrets").is_none());
        assert!(api_route("/user?x=%2fetc").is_none());
        assert!(api_route("/user/repos?per_page=0&per_page=1").is_none());
        assert!(api_route("/user/repos?q=hello").is_none());
    }

    #[test]
    fn api_methods_are_restricted_per_route() {
        assert!(route_allows_method(api_route("/user").unwrap(), "GET"));
        assert!(!route_allows_method(api_route("/user").unwrap(), "POST"));
        assert!(route_allows_method(
            api_route("/user/repos").unwrap(),
            "GET"
        ));
        assert!(route_allows_method(
            api_route("/user/repos").unwrap(),
            "POST"
        ));
        assert!(!route_allows_method(
            api_route("/user/repos").unwrap(),
            "DELETE"
        ));
        assert!(route_allows_method(
            api_route("/repos/a/b/issues/1/comments").unwrap(),
            "POST"
        ));
        assert!(!route_allows_method(
            api_route("/repos/a/b/issues/1/comments").unwrap(),
            "PATCH"
        ));
        assert!(route_allows_method(
            api_route("/repos/a/b/issues/1").unwrap(),
            "PATCH"
        ));
        assert!(route_allows_method(
            api_route("/repos/a/b/pulls/1/merge").unwrap(),
            "PUT"
        ));
        assert!(!route_allows_method(
            api_route("/repos/a/b/pulls/1/merge").unwrap(),
            "POST"
        ));
    }

    #[test]
    fn token_masking_only_reveals_the_last_four_characters() {
        assert_eq!(masked_token("ghp_abcdefghijklmnopqrstuvwxyz"), "••••wxyz");
    }
}
