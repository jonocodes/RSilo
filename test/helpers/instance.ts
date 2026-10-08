// Per-Instance config that production mode (RSILO_DEV_MODE !== 'true')
// requires. Dev mode defaults to the same Account at http://localhost:8787,
// owned by alice@example.com.
export const PRODUCTION_INSTANCE = {
  ACCOUNT_USERNAME: 'alice',
  OWNER_EMAIL: 'owner@example.com',
  PUBLIC_BASE_URL: 'https://rsilo.example',
};
