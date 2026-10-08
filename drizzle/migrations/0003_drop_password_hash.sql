-- Cloudflare Access now signs the Owner in (ADR-0001), so RSilo stores no
-- passwords. The Account row keeps its role as the join target for App
-- authorizations and the quota counter (ADR-0002).
ALTER TABLE users DROP COLUMN password_hash;
