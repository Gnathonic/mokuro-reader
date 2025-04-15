export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

export interface RefreshTokenRequest {
  refresh_token: string;
}

export interface AuthError {
  error: string;
  error_description?: string;
}