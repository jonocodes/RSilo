-- Folder ETag cache (services/folder-etags.ts). A folder's ETag is derived
-- from every document below it, so computing it lists the whole subtree; this
-- table memoizes it per folder.
--
-- user_id is the Account's username, as in storage keys and oauth_tokens.
-- path is the folder below the storage root with a trailing '/', and '' for
-- the root. version counts RSilo writes below the folder; etag is the cached
-- ETag (unquoted), valid only while etag_version = version and for a bounded
-- time after cached_at (unix seconds).
CREATE TABLE folder_etags (
  user_id TEXT NOT NULL,
  path TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  etag TEXT,
  etag_version INTEGER,
  cached_at INTEGER,
  PRIMARY KEY (user_id, path)
);
