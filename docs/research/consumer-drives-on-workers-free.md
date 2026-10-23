# Can RSilo store files in Google Drive, Dropbox, OneDrive or Nextcloud on Workers Free?

> **Status:** a snapshot from 2026-10-22. "What RSilo does now" describes that day's code. Nothing here has been built.

Researched 2026-10-22 from primary sources only: provider API and OAuth docs, Cloudflare's docs, Dropbox's Stone API spec, and the source of Nextcloud server, sabre/dav, unstorage, Uppy Companion and remotestorage.js. Anything the sources didn't settle is marked **unverified**.

**Verdict:** Nextcloud is a straightforward adapter. Dropbox and OneDrive work with caveats: someone has to own a shared OAuth app, and RSilo has to keep Content-Type itself. Google Drive doesn't fit `StorageInterface` on Workers Free. It has no paths, no recursive listing and no write preconditions, so it only works if RSilo keeps a path and version index in D1. No JavaScript library covers these drives behind one API in a Worker.

## What RSilo does now

- `StorageInterface` (`src/types.ts`) is `get`/`put`/`delete`/`head`/`list(prefix)`. `list` returns every key under the prefix, recursively.
- A folder `GET` (`handleFolderGet` in `src/routes/storage.ts`) calls `storage.list(folderKey)` once. It builds the folder's ETag, and each subfolder's ETag, by hashing every descendant document's relative path and ETag (`folderVersion`). A backend therefore has to list a whole subtree with per-file versions, or RSilo has to get folder versions some other way.
- A `PUT` (`putUserObject` in `src/services/quota-storage.ts`) makes these calls in parallel: one `head` on the document, one `head` per ancestor folder, and `list(key + '/', { limit: 1 })` for the 409 check. Then it makes one `put` conditioned on the ETag it just read. `S3Storage` ignores that condition (ADR-0005), so on S3 the write isn't atomic.
- Request bodies are buffered. `readRequestBody` reads up to `MAX_OBJECT_SIZE_BYTES` (10 MiB by default) into an `ArrayBuffer`, and `put` takes an `ArrayBuffer`. `GET` bodies are streamed. `S3Storage.get` returns the `fetch` response's `ReadableStream` untouched, which is the pattern ADR-0007 relies on to stay inside the CPU limit.

## Workers Free limits that matter

From [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) unless noted:

- **Subrequests:** 50 per invocation on Free (10,000 on Paid). "A subrequest is any request a Worker makes using the Fetch API or to Cloudflare services like R2, KV, or D1." Subrequests to Cloudflare's internal services have their own limit of 1,000 on Free. "Each subrequest in a redirect chain counts against this limit."
- **CPU:** 10 ms per request. "Waiting on network requests (such as fetch() calls, KV reads, or database queries) does not count toward CPU time." Piping a `fetch` body straight into the `Response` is therefore cheap at any size. Parsing a large JSON listing or hashing thousands of entries is not.
- **Connections:** at most six per invocation "simultaneously waiting for response headers."
- **Memory:** 128 MB per isolate.
- **Request bodies:** limited by the zone's plan (100 MB on Free). "Cloudflare does not enforce response body size limits."
- **Daily requests:** 100,000 per day, reset at midnight UTC. Past that, requests get Error 1027.
- **Worker size:** the page now lists 64 MiB uncompressed for both plans and says "There is no compressed size limit." ADR-0007 originally cited a 3 MB Free limit and has been corrected.
- **Fetch behaviour** ([compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)): `allow_custom_ports` has been on by default since 2024-09-02, so a self-hosted WebDAV server on a non-standard port is reachable as long as it isn't behind Cloudflare's proxy. Since 2025-09-01, `strip_authorization_on_cross_origin_redirect` removes `Authorization` when a redirect leaves the origin.
- **Streams** ([Streams API](https://developers.cloudflare.com/workers/runtime-apis/streams/), [FixedLengthStream](https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/)): `new Response(response.body, response)` streams a subrequest's body through. A `FixedLengthStream` body is sent with `Content-Length`; any other stream is sent chunked.

All four providers serve downloads as a plain authenticated `GET` whose body the Worker can pass through. The real constraints are the 50-subrequest budget, given how each provider resolves paths and lists folders, and OAuth app ownership.

## OAuth: one shared app, or one per Owner?

Every Instance has its own origin (`<worker>.<account>.workers.dev`), and `workers.dev` is on the [Public Suffix List](https://publicsuffix.org/list/public_suffix_list.dat). So every Owner's subdomain is a separate site. A shared app would need every Instance's redirect URI registered. None of the three consumer providers accepts a wildcard or an unlimited list. All four do offer a flow that needs no redirect URI, which is what makes a shared client possible.

### Google Drive

- **Scopes.** [`drive.file` and `drive.appdata` are non-sensitive ("recommended")](https://developers.google.com/workspace/drive/api/guides/api-specific-auth). Full `drive` is restricted, and restricted scopes need a security assessment if data is stored or transmitted on servers. `drive.file` covers files the app creates or that the user opens with it, so RSilo's files are visible in the Owner's Drive. The [application data folder](https://developers.google.com/workspace/drive/api/guides/appdata) is hidden from the user and other apps, can't be shared, and the user can delete it.
- **Redirect URIs** [must match exactly, and wildcards aren't allowed](https://developers.google.com/identity/protocols/oauth2/web-server). Google's [verification requirements](https://support.google.com/cloud/answer/13464321) say every app must pass brand verification, including proving ownership of each authorized domain in Search Console. RSilo's maintainers can't do that for each Owner's subdomain.
- **No-redirect option.** The [device flow](https://developers.google.com/identity/protocols/oauth2/limited-input-device) ("TVs and Limited Input devices" client) supports `drive.file` and `drive.appdata`. It assumes "the apps cannot keep secrets", so a client ID embedded in every Instance is acceptable.
- **User caps.** Projects in Testing status are [limited to 100 test users, and their authorizations expire after seven days](https://support.google.com/cloud/answer/15549945). Unverified apps are [limited to 100 new users "after the app presents the unverified app screen"](https://support.google.com/cloud/answer/7454865), and that page ties the screen to sensitive or restricted scopes. So a published app using only `drive.file` probably shows no warning and has no cap, but still needs brand verification. That combination is **unverified**. [Personal-use apps with fewer than 100 users are exempt from verification](https://support.google.com/cloud/answer/13464323).
- **Refresh tokens** [stop working](https://developers.google.com/identity/protocols/oauth2) after six months unused, after seven days in Testing status, and when a client exceeds 100 refresh tokens per Google Account.
- **Shared quota.** API quota is per project. [Per day there's a "billing threshold" of 400,000,000 quota units per project, and charges above it are "planned … later in 2026"](https://developers.google.com/workspace/drive/api/guides/limits). A list costs 100 units, an edit 50 and a read 5. A shared client pools every Owner's usage under one project and one billing account.
- **Per-Owner alternative.** Each Owner creates a Cloud project and OAuth client, which is a lot to ask of a non-technical Owner. Left in Testing, it would need re-linking every seven days.

### Dropbox

- **Access types.** [App Folder access confines the app to `/Apps/<app name>`](https://docs.dropboxapi.com/dropbox-api/docs/oauth). Scopes per route come from [Dropbox's API spec](https://github.com/dropbox/dropbox-api-spec/blob/master/files.stone): `files.content.read`, `files.content.write` and `files.metadata.read`.
- **Redirect URIs.** The [authorization reference](https://docs.dropboxapi.com/dropbox-api/docs/get-started/authorization.md) says `redirect_uri` "must be the exact URI registered in the App Console." It is optional for the code flow: without one, "the `code` will be presented directly to the user". The Owner pastes that code into `/account`, and no per-Instance registration is needed. PKCE replaces the client secret for "open-source apps" ([OAuth guide](https://docs.dropboxapi.com/dropbox-api/docs/oauth)). How many redirect URIs an app may have, and whether wildcards work, is **unverified**.
- **Tokens.** With `token_access_type=offline`, the refresh token "is long-lived and won't expire automatically." The examples show access tokens with `expires_in: 14400` (4 hours).
- **App status.** A new app is in development status and [can link at most 500 Dropbox users](https://docs.dropboxapi.com/dropbox-api/docs/developer-resources/developer-guide). Once it has linked 50 users, it has two weeks to get production approval, which includes a review against Dropbox's branding guidelines and terms. A per-Owner app in development status (free, a few clicks in the App Console) is the easiest per-Owner registration of the three consumer providers.

### OneDrive (Microsoft Graph)

- **Scope.** `Files.ReadWrite.AppFolder` gives access to [`/drive/special/approot`](https://learn.microsoft.com/en-us/onedrive/developer/rest-api/concepts/special-folders-appfolder), a visible folder under `Apps/` that the user can rename or move.
- **Redirect URIs.** [Wildcards are unsupported for apps that sign in personal accounts, and such apps get at most 100 redirect URIs](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url). The same page says redirect URIs aren't needed for the device code flow. The [device code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code) supports `/consumers`, takes no client secret, and returns a refresh token when `offline_access` is requested.
- **Refresh tokens** last [90 days by default (24 hours for SPA redirects)](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens). They "replace themselves with a fresh token upon every use", so in practice the window slides, and an Instance idle for 90 days must be re-linked.
- **Publisher verification.** Since November 2020, users in other tenants can't consent to unverified multitenant apps when risk-based step-up consent is enabled ([publisher verification](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview)). Verification needs a Partner Program account. Apps registered with a personal Microsoft account can't be verified. The docs don't say whether this restriction affects personal-account users. **Unverified**, but they read as tenant-scoped.
- **Per-Owner registration** lists ["an Azure account that has an active subscription"](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app) as a prerequisite, which is too much for a non-technical Owner. Whether that subscription needs a payment card is **unverified**.

### Nextcloud (WebDAV)

- No app registration. [Login Flow v2](https://docs.nextcloud.com/server/latest/developer_manual/client_apis/LoginFlow/index.html) is an anonymous `POST /index.php/login/v2`, then the user signs in in a browser, then RSilo polls with a token valid for 20 minutes. The result is `server`, `loginName` and `appPassword`.
- The app password doesn't expire. The user can revoke it from the web UI, and a client can delete it with `DELETE /ocs/v2.php/core/apppassword`. It works with HTTP Basic auth. For any other WebDAV server the Owner would type a URL, username and password.

## Data path

| | Google Drive | Dropbox | OneDrive | Nextcloud |
|---|---|---|---|---|
| Download | `files.get?alt=media` returns the bytes, and `Range` works ([downloads](https://developers.google.com/workspace/drive/api/guides/manage-downloads)) | `GET content.dropboxapi.com/2/files/download` with `Dropbox-API-Arg`. Metadata comes back in the `Dropbox-API-Result` header. Supports `If-None-Match` and ranges ([formats](https://docs.dropboxapi.com/dropbox-api/docs/technical-reference/request-response-formats.md)) | `GET …/content` answers `302` to a pre-authenticated URL that needs no `Authorization` ([get content](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0)). That's 2 subrequests. `Range` must go to the redirect target | Plain `GET` |
| Single-request upload | `uploadType=media`/`multipart` only up to 5 MB, larger needs `resumable` (2+ requests) ([uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads)). Creating a file with a name and parent needs a `multipart/related` body | `files/upload`, raw body, up to 150 MB (spec) | `PUT …:/content`, raw body, up to 250 MB ([put content](https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0)) | `PUT`, raw body. The limit depends on the server, for example Apache's 1 GiB `LimitRequestBody` default ([big files](https://docs.nextcloud.com/server/latest/admin_manual/configuration_files/big_file_upload_configuration.html)) |
| Stores the upload's Content-Type | Yes (`mimeType`) | No. `FileMetadata` has no MIME field ([spec](https://github.com/dropbox/dropbox-api-spec/blob/master/files.stone)) | No. `mimeType` "is determined by logic on the server and might not be the value provided" ([file facet](https://learn.microsoft.com/en-us/graph/api/resources/file?view=graph-rest-1.0)) | No. `File.php` takes the type from Nextcloud's own detection, not the request ([source](https://github.com/nextcloud/server/blob/master/apps/dav/lib/Connector/Sabre/File.php)) |

Drive's 5 MB single-request limit is below RSilo's 10 MiB default, so larger documents cost an extra subrequest. remoteStorage requires a document's Content-Type to round-trip, so on Dropbox, OneDrive and Nextcloud RSilo would have to store it in D1.

## Addressing, listing, versions and preconditions

| | Google Drive | Dropbox | OneDrive (personal) | Nextcloud |
|---|---|---|---|---|
| Addressing | By ID only. A path costs one `files.list` per segment | By path, [case-insensitive](https://docs.dropboxapi.com/dropbox-api/docs/technical-reference/request-response-formats.md). Paths can't end in whitespace | By path (`approot:/a/b:`). [Reserved characters](https://learn.microsoft.com/en-us/graph/onedrive-addressing-driveitems) are `/ \ * < > ? : \|`. Names can't start with `~`, and folder names can't end with `.` | By path |
| Recursive listing | None. One [`files.list`](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list) per folder (`pageSize` up to 1000, "may return fewer") | `list_folder` `recursive: true`, `limit` up to 2000 (approximate), with a cursor (spec) | `children` is one level, 200 items per page by default ([list children](https://learn.microsoft.com/en-us/graph/api/driveitem-list-children?view=graph-rest-1.0)). The App Folder doc lists `delta` on `approot` | `PROPFIND Depth: 1`. Nextcloud turns on `Depth: infinity` ([source](https://github.com/nextcloud/server/blob/master/apps/dav/lib/Connector/Sabre/Server.php)), which sabre/dav [leaves off by default](https://github.com/sabre-io/dav/blob/master/lib/DAV/Server.php). [RFC 4918 §9.1](https://www.rfc-editor.org/rfc/rfc4918.html) lets servers refuse infinity |
| Per-file version | `version` ("reflects every change"), `md5Checksum`, `headRevisionId` ([File](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)) | `rev` ("can be used to detect changes and avoid conflicts"), `content_hash` | `eTag` (metadata + content), `cTag` (content) ([driveItem](https://learn.microsoft.com/en-us/graph/api/resources/driveitem?view=graph-rest-1.0)) | `getetag` |
| Folder version from the backend | No | No | Yes: a folder's `cTag` "is modified when content or metadata of any descendant … is changed". OneDrive for Business doesn't return it | Yes: [`Propagator`](https://github.com/nextcloud/server/blob/master/lib/private/Files/Cache/Propagator.php) gives every ancestor folder a new etag on each change |
| Conditional write | None documented in v3. v3 has no `etag` ([v2→v3](https://developers.google.com/workspace/drive/api/guides/v2-to-v3-reference)) | `WriteMode.update(rev)` overwrites only if the rev matches. `add` won't overwrite. `strict_conflict` makes identical content conflict too (spec) | `If-Match`/`If-None-Match` documented on [createUploadSession](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0) (2 requests), not on simple `PUT`. `conflictBehavior=fail` refuses to overwrite | `If-Match`/`If-None-Match` checked by sabre/dav's `checkPreconditions` in the same request |
| Conditional delete | No | `delete_v2` `parent_rev` (spec) | `if-match` → 412 ([delete](https://learn.microsoft.com/en-us/graph/api/driveitem-delete?view=graph-rest-1.0)) | `If-Match` |
| Duplicate names | Allowed: a name "isn't necessarily unique within a folder" | No | No | No |
| Missing parent folders on write | Must be created first (one call each) | Created automatically. A file in the way gives `file_ancestor` (spec), which is RSilo's 409 in one call | **Unverified** | `PUT` fails with 409 ([RFC 4918 §9.7.1](https://www.rfc-editor.org/rfc/rfc4918.html#section-9.7.1)), so RSilo needs one `MKCOL` per missing folder |
| Rate limits | Quota units per minute and per day ([limits](https://developers.google.com/workspace/drive/api/guides/limits)) | Per user, unpublished. `429` with `Retry-After`, and `too_many_write_operations` on namespace lock contention ([performance](https://docs.dropboxapi.com/dropbox-api/docs/performance.md)) | **Unverified** for personal accounts | The server's own |

Two notes on the table:

- remotestorage.js's own Drive backend works around v3 by calling the v2 API with `If-Match`, using the restricted `drive` scope ([`src/googledrive.ts`](https://github.com/remotestorage/remotestorage.js/blob/master/src/googledrive.ts)). It leaves folder revisions as `// FIXME`. The v2 `File` has an `etag` field, but Google's reference doesn't document `If-Match` on v2 writes (**unverified**).
- In Dropbox's `add` mode, a write with the same content as the existing file isn't a conflict unless `strict_conflict` is set.

### What a folder GET costs

- **Nextcloud:** one `PROPFIND Depth: 1`. Subfolders' propagated etags can stand in for RSilo's descendant hash.
- **OneDrive personal:** one `children` call per 200 items, using subfolders' `cTag`.
- **Dropbox:** one recursive `list_folder` call per ~2,000 descendants. The CPU to parse and hash a large tree within 10 ms is the risk, as it is for S3 today.
- **Google Drive:** one `files.list` per folder in the subtree, plus one per path segment to find the folder. A tree with more than about 45 folders can't be listed within 50 subrequests. Every `head` on an ancestor during a `PUT` also needs a path lookup.

Making OneDrive and Nextcloud efficient means changing the interface. `StorageInterface.list` would need a shallow mode that returns folder versions, and RSilo's `folderVersion` hash would have to accept a backend's own folder version.

## Is there a library?

No. Nothing open source covers these drives behind one API and runs in a Worker:

- **unstorage** (latest tag v2.0.0-beta.0, 2026-10-20): the [drivers directory](https://github.com/unjs/unstorage/tree/main/src/drivers) has Azure, Cloudflare KV/R2/cache, Deno KV, fs, GitHub, HTTP, IndexedDB, MongoDB, Netlify Blobs, Redis, S3, Upstash, UploadThing, Vercel Blob and others. It has no Google Drive, Dropbox, OneDrive or WebDAV driver.
- **Uppy Companion** (v7.2.0) is an Express server requiring Node ≥ 22 ([package.json](https://github.com/transloadit/uppy/blob/main/packages/@uppy/companion/package.json)). It has providers for Box, Dropbox, Facebook, Google, OneDrive, S3, Unsplash, WebDAV and Zoom. Its [`Provider`](https://github.com/transloadit/uppy/blob/main/packages/@uppy/companion/src/server/provider/Provider.ts) interface has `list`, `download`, `deleteItem`, `moveItem` and `createFolder`, but no way to write a file's content. It's built for importing files, not storing them.
- **unifile** requires Node ≤ 12 and the `request` package, and was last pushed in 2022 ([repo](https://github.com/silexlabs/unifile)). Its connectors are Dropbox, FTP, SFTP, fs, GitHub and remoteStorage.
- **bucketfs** (JSR) lists Workers as a target but supports only Dropbox among these drives ([README](https://jsr.io/@pinta365/bucketfs/0.2.0/README.md)).
- **remotestorage.js** has browser backends for Dropbox and Google Drive. They are worth reading as prior art for mapping remoteStorage onto those APIs, but they aren't a server library.

Each API is small enough for a thin `fetch` adapter, as `S3Storage` is over `aws4fetch`. Whether each provider's official JS SDK runs in a Worker is **unverified** and wasn't needed.

### Aside: Dropbox Object Storage

Dropbox documents an [S3-compatible "Object Storage"](https://docs.dropboxapi.com/object-storage/docs/api-compatibility.md) at `https://seal.dropboxapi.com` with ListObjectsV2 and conditional writes. RSilo's existing S3 adapter might reach it with no new code. Its [credentials](https://docs.dropboxapi.com/object-storage/docs/configuration.md) cover "all buckets owned by your team". Whether ordinary or free Dropbox accounts can use it, and what it costs, is **unverified**.

## Verdicts

| Backend | Verdict on Workers Free | Why |
|---|---|---|
| Nextcloud (WebDAV) | **Feasible** | Paths, `If-Match`, propagated folder etags, one-request listings, and no app registration. Caveats: Content-Type must be kept in D1, each missing parent costs one `MKCOL`, and the server must be publicly reachable. Generic WebDAV servers may lack etag propagation or infinite depth. |
| Dropbox | **Feasible with caveats** | Paths, recursive listing, atomic `rev` writes and deletes, and auto-created parents. Caveats: someone must own the shared app (production review after 50 users) or each Owner registers one. Content-Type must be kept in D1. Paths are case-insensitive, so `a.json` and `A.json` collide. |
| OneDrive (personal) | **Feasible with caveats** | Paths, an App Folder, and folder `cTag`s that track descendants. Caveats: the maintainers must own a multitenant app that uses the device code flow. A download costs 2 subrequests. Conditional writes need an upload session (2 requests; whether the condition is rechecked at commit is **unverified**). Content-Type must be kept in D1. Reserved characters need escaping. Refresh tokens lapse after 90 idle days. |
| Google Drive | **Not feasible as a `StorageInterface` adapter.** Feasible with caveats only behind a D1 index | It has no paths, no recursive listing, no write preconditions, and allows duplicate names. Listings and path lookups use up the 50-subrequest budget, and writes can't be made atomic. A D1 table of path, file ID, version and Content-Type would fix listing and preconditions, but that is a new architecture, not an adapter. |

### Biggest blockers, ranked

1. **Google Drive's ID-only model on a 50-subrequest budget.** It needs a D1 metadata index, or no Drive support at all.
2. **Who owns the OAuth app.** A shared client makes the RSilo project an operator: Google brand verification with a domain it owns, Dropbox production review, an Azure tenant for Microsoft, and pooled Drive quota. Per-Owner registration is realistic only for Dropbox. The device and code-paste flows remove per-Instance redirect URIs, so app ownership, not redirect URIs, is the cost.
3. **Content-Type doesn't round-trip** on Dropbox, OneDrive or Nextcloud. That means a D1 sidecar written on every `PUT`.
4. **Name semantics.** Dropbox is case-insensitive, OneDrive has reserved characters, and remoteStorage paths are case-sensitive. RSilo needs an escaping layer and a collision policy.
5. **Linked accounts expire.** OneDrive after 90 idle days, Google after six months unused (or seven days in Testing status). The `/account` page would need a "re-link" state.
6. **Folder ETags.** `StorageInterface.list` would need a shallow mode with backend folder versions to use what OneDrive and Nextcloud already compute.
