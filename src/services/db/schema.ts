export interface User {
  id: string;
  username: string;
  created_at: number;
  updated_at: number;
  storage_quota_bytes: number;
  used_storage_bytes: number;
}

// Secrets (codes, access and refresh tokens) are stored only as base64url
// SHA-256 hashes; see hashToken in services/auth.ts.
export interface OAuthCode {
  code_hash: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  expires_at: number;
  created_at: number;
}

export interface OAuthClient {
  id: string;
  name: string;
  redirect_uris: string;
  created_at: number;
  user_id: string;
}

export interface OAuthToken {
  id: string;
  access_token_hash: string;
  refresh_token_hash: string | null;
  previous_refresh_token_hash: string | null;
  expires_at: number;
  scopes: string;
  user_id: string;
  client_id: string;
  created_at: number;
}
