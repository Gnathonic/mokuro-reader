use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use serde::{Deserialize, Serialize};

const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";

// OAuth state for PKCE flow
#[derive(Clone)]
struct OAuthState {
    state: String,
    code_verifier: String,
    client_id: String,
    client_secret: String,
    redirect_uri: String,
}

// Store for pending OAuth state
static OAUTH_STATE: std::sync::OnceLock<Arc<Mutex<Option<OAuthState>>>> = std::sync::OnceLock::new();

fn get_oauth_state() -> &'static Arc<Mutex<Option<OAuthState>>> {
    OAUTH_STATE.get_or_init(|| Arc::new(Mutex::new(None)))
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
    refresh_token: Option<String>,
    token_type: String,
}

#[derive(Serialize, Clone)]
struct TokenPayload {
    access_token: String,
    expires_in: u64,
    refresh_token: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct RefreshResponse {
    access_token: String,
    expires_in: u64,
}

#[tauri::command]
async fn start_oauth_server(
    app: AppHandle,
    state: String,
    port: u16,
    code_verifier: String,
    client_id: String,
    client_secret: String,
    redirect_uri: String,
) -> Result<(), String> {
    // Store the OAuth state for verification and token exchange
    {
        let oauth_state = get_oauth_state();
        let mut guard = oauth_state.lock().map_err(|e| e.to_string())?;
        *guard = Some(OAuthState {
            state: state.clone(),
            code_verifier,
            client_id,
            client_secret,
            redirect_uri,
        });
    }

    // Start TCP listener on the specified port
    let listener = TcpListener::bind(format!("127.0.0.1:{}", port))
        .map_err(|e| format!("Failed to bind to port {}: {}", port, e))?;

    listener.set_nonblocking(false).ok();

    log::info!("OAuth server listening on 127.0.0.1:{}", port);

    // Clone app handle for use in thread
    let app_clone = app.clone();

    // Handle the connection in a separate thread
    std::thread::spawn(move || {
        // Accept one connection
        if let Ok((mut stream, _)) = listener.accept() {
            let mut buffer = [0; 4096];
            if let Ok(n) = stream.read(&mut buffer) {
                let request = String::from_utf8_lossy(&buffer[..n]);

                // Parse the request to get the path
                if let Some(path_line) = request.lines().next() {
                    let parts: Vec<&str> = path_line.split_whitespace().collect();
                    if parts.len() >= 2 {
                        let path = parts[1];
                        log::info!("OAuth callback received: {}", path);

                        // Parse query parameters from the callback URL
                        // Format: /callback?code=xxx&state=yyy
                        if path.starts_with("/callback?") {
                            let query = &path[10..]; // Skip "/callback?"
                            let params: std::collections::HashMap<&str, &str> = query
                                .split('&')
                                .filter_map(|p| {
                                    let mut parts = p.splitn(2, '=');
                                    Some((parts.next()?, parts.next()?))
                                })
                                .collect();

                            // Get stored OAuth state
                            let stored_state = {
                                let oauth_state = get_oauth_state();
                                oauth_state.lock().ok().and_then(|g| g.clone())
                            };

                            if let Some(oauth) = stored_state {
                                // Verify state
                                if params.get("state").map(|s| *s) != Some(oauth.state.as_str()) {
                                    log::error!("OAuth state mismatch");
                                    let _ = app_clone.emit("oauth-error", "State mismatch");
                                    send_error_response(&mut stream, "State mismatch");
                                    return;
                                }

                                // Get authorization code
                                if let Some(code) = params.get("code") {
                                    log::info!("Got authorization code, exchanging for tokens...");

                                    // Exchange code for tokens
                                    match exchange_code_for_tokens(
                                        code,
                                        &oauth.code_verifier,
                                        &oauth.client_id,
                                        &oauth.client_secret,
                                        &oauth.redirect_uri,
                                    ) {
                                        Ok(tokens) => {
                                            log::info!("Token exchange successful");

                                            // Emit tokens to frontend
                                            let payload = TokenPayload {
                                                access_token: tokens.access_token,
                                                expires_in: tokens.expires_in,
                                                refresh_token: tokens.refresh_token,
                                            };

                                            let _ = app_clone.emit("oauth-token", payload);
                                            send_success_response(&mut stream);
                                        }
                                        Err(e) => {
                                            log::error!("Token exchange failed: {}", e);
                                            let _ = app_clone.emit("oauth-error", e.clone());
                                            send_error_response(&mut stream, &e);
                                        }
                                    }
                                } else if let Some(error) = params.get("error") {
                                    log::error!("OAuth error from Google: {}", error);
                                    let _ = app_clone.emit("oauth-error", *error);
                                    send_error_response(&mut stream, error);
                                }
                            } else {
                                log::error!("No stored OAuth state");
                                let _ = app_clone.emit("oauth-error", "No pending OAuth request");
                                send_error_response(&mut stream, "No pending OAuth request");
                            }
                        } else {
                            // Not a callback request, send a simple response
                            send_error_response(&mut stream, "Invalid request");
                        }
                    }
                }
            }
        }

        // Clear OAuth state after handling
        if let Ok(mut guard) = get_oauth_state().lock() {
            *guard = None;
        }
    });

    Ok(())
}

fn exchange_code_for_tokens(
    code: &str,
    code_verifier: &str,
    client_id: &str,
    client_secret: &str,
    redirect_uri: &str,
) -> Result<TokenResponse, String> {
    let client = reqwest::blocking::Client::new();

    let mut params = vec![
        ("code", code),
        ("client_id", client_id),
        ("code_verifier", code_verifier),
        ("redirect_uri", redirect_uri),
        ("grant_type", "authorization_code"),
    ];

    // Add client_secret if provided
    if !client_secret.is_empty() {
        params.push(("client_secret", client_secret));
    }

    let response = client
        .post(TOKEN_ENDPOINT)
        .form(&params)
        .send()
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        log::error!("Token exchange failed: {} - {}", status, body);
        return Err(format!("Token exchange failed: {}", status));
    }

    response
        .json::<TokenResponse>()
        .map_err(|e| format!("Failed to parse token response: {}", e))
}

#[tauri::command]
async fn refresh_oauth_token(
    refresh_token: String,
    client_id: String,
    client_secret: String,
) -> Result<RefreshResponse, String> {
    let client = reqwest::blocking::Client::new();

    let mut params = vec![
        ("refresh_token", refresh_token.as_str()),
        ("client_id", client_id.as_str()),
        ("grant_type", "refresh_token"),
    ];

    // Add client_secret if provided
    if !client_secret.is_empty() {
        params.push(("client_secret", client_secret.as_str()));
    }

    let response = client
        .post(TOKEN_ENDPOINT)
        .form(&params)
        .send()
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        log::error!("Token refresh failed: {} - {}", status, body);
        return Err(format!("Token refresh failed: {}", status));
    }

    let token_response: TokenResponse = response
        .json()
        .map_err(|e| format!("Failed to parse token response: {}", e))?;

    Ok(RefreshResponse {
        access_token: token_response.access_token,
        expires_in: token_response.expires_in,
    })
}

fn send_success_response(stream: &mut std::net::TcpStream) {
    let html = r#"<!DOCTYPE html>
<html>
<head><title>Authentication Complete</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
       display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;
       background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; }
.container { text-align: center; padding: 40px; }
h1 { margin-bottom: 10px; }
p { opacity: 0.9; }
</style>
</head>
<body>
<div class="container">
<h1>✓ Authentication Successful</h1>
<p>You can close this window and return to Mokuro Reader.</p>
</div>
</body>
</html>"#;

    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html
    );
    stream.write_all(response.as_bytes()).ok();
    stream.flush().ok();
}

fn send_error_response(stream: &mut std::net::TcpStream, error: &str) {
    let html = format!(r#"<!DOCTYPE html>
<html>
<head><title>Authentication Failed</title>
<style>
body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
       display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0;
       background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: white; }}
.container {{ text-align: center; padding: 40px; }}
h1 {{ margin-bottom: 10px; }}
p {{ opacity: 0.9; }}
</style>
</head>
<body>
<div class="container">
<h1>✗ Authentication Failed</h1>
<p>{}</p>
<p>Please close this window and try again.</p>
</div>
</body>
</html>"#, error);

    let response = format!(
        "HTTP/1.1 400 Bad Request\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        html.len(),
        html
    );
    stream.write_all(response.as_bytes()).ok();
    stream.flush().ok();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_deep_link::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .invoke_handler(tauri::generate_handler![start_oauth_server, refresh_oauth_token])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
