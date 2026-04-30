export interface User {
  id: string;
  username: string;
  created_at: number;
  updated_at: number;
  storage_quota_bytes: number;
  used_storage_bytes: number;
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