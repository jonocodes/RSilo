export interface User {
  id: string;
  username: string;
  created_at: number;
  updated_at: number;
  storage_quota_bytes: number;
  used_storage_bytes: number;
}

export interface OAuthCode {
  code: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  scope: string;
  expires_at: number;
  created_at: number;
  code_challenge: string | null;
  code_challenge_method: string | null;
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
  access_token: string;
  refresh_token: string | null;
  expires_at: number;
  scopes: string;
  user_id: string;
  client_id: string;
  created_at: number;
}