//! Throwaway: can OpenDAL run inside a Cloudflare Worker as RSilo's storage?
//!
//! `GET /<key>`, `PUT /<key>`, `DELETE /<key>` map to the backend; `GET /<prefix>/` lists it.
//! Bodies stream both ways. `If-Match` / `If-None-Match` pass through to the backend.
//!
//! The backend comes from config: `STORAGE_SCHEME` (an OpenDAL scheme such as `s3`
//! or `webdav`) plus every other `STORAGE_<KEY>` var or secret, passed to OpenDAL
//! as `<key>` lowercased. So `STORAGE_ACCESS_KEY_ID` becomes `access_key_id`.
use futures_util::{StreamExt, TryStreamExt};
use opendal::{ErrorKind, Operator};
use percent_encoding::percent_decode_str;
use worker::wasm_bindgen::JsCast;
use worker::*;

/// S3 multipart parts must be at least 5 MiB, so PUT bodies are buffered up to this much at a time.
const CHUNK: usize = 5 * 1024 * 1024;

fn operator(env: &Env) -> Result<Operator> {
    // `#[ctor]` doesn't run on wasm32, so install the reqwest (fetch) transport and service registry by hand.
    opendal::install_default();

    let mut scheme = None;
    let mut options = Vec::new();
    let entries = js_sys::Object::entries(env.unchecked_ref::<js_sys::Object>());
    for entry in entries.iter() {
        let pair: js_sys::Array = entry.unchecked_into();
        let (Some(name), Some(value)) = (pair.get(0).as_string(), pair.get(1).as_string()) else {
            continue;
        };
        match name.strip_prefix("STORAGE_") {
            Some("SCHEME") => scheme = Some(value),
            Some(key) => options.push((key.to_lowercase(), value)),
            None => {}
        }
    }
    let scheme = scheme.ok_or_else(|| Error::RustError("STORAGE_SCHEME is not set".into()))?;
    if scheme == "s3" {
        // No AWS config files or instance metadata in a Worker.
        options.push(("disable_config_load".into(), "true".into()));
        options.push(("disable_ec2_metadata".into(), "true".into()));
    }
    Operator::via_iter(&scheme, options).map_err(err)
}

fn err(e: opendal::Error) -> Error {
    Error::RustError(e.to_string())
}

/// Maps an OpenDAL error to the HTTP status RSilo would send.
fn error_response(e: opendal::Error) -> Result<Response> {
    let status = match e.kind() {
        ErrorKind::NotFound => 404,
        ErrorKind::ConditionNotMatch => 412,
        ErrorKind::Unsupported => 501,
        _ => return Err(err(e)),
    };
    Response::error(e.to_string(), status)
}

fn with_etag(resp: Response, etag: Option<&str>) -> Result<Response> {
    let mut resp = resp;
    if let Some(etag) = etag {
        resp.headers_mut().set("ETag", etag)?;
    }
    Ok(resp)
}

#[event(fetch)]
async fn fetch(mut req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let op = operator(&env)?;
    let path = req.path();
    let key = percent_decode_str(path.trim_start_matches('/'))
        .decode_utf8()
        .map_err(|e| Error::RustError(e.to_string()))?
        .into_owned();
    let if_match = req.headers().get("If-Match")?;
    let if_none_match = req.headers().get("If-None-Match")?;

    match req.method() {
        Method::Get if key.is_empty() || key.ends_with('/') => {
            let names: Vec<String> = match op.list(&key).await {
                Ok(entries) => entries.into_iter().map(|e| e.path().to_string()).collect(),
                Err(e) => return error_response(e),
            };
            Response::from_json(&names)
        }

        Method::Get => {
            let mut stat = op.stat_with(&key);
            if let Some(v) = &if_match {
                stat = stat.if_match(v);
            }
            if let Some(v) = &if_none_match {
                stat = stat.if_none_match(v);
            }
            let meta = match stat.await {
                Ok(meta) => meta,
                Err(e) if e.kind() == ErrorKind::ConditionNotMatch && if_none_match.is_some() => {
                    return Response::empty().map(|r| r.with_status(304));
                }
                Err(e) => return error_response(e),
            };
            // No `If-Match: <stat etag>` pin on the read: SeaweedFS WebDAV gives chunked files
            // a different ETag on PROPFIND than on GET, so the pin 412s every large file.
            let mut stream = match op.reader(&key).await {
                Ok(r) => r.into_bytes_stream(..).await.map_err(err)?,
                Err(e) => return error_response(e),
            };
            // Pull the first chunk before sending headers: an error after that can only
            // truncate the body, and the client sees an empty `200`.
            let first = stream.try_next().await.map_err(|e| Error::RustError(e.to_string()))?;
            let body = futures_util::stream::iter(first.map(Ok))
                .chain(stream)
                .map_ok(|b| b.to_vec())
                .map_err(|e| Error::RustError(e.to_string()));
            with_etag(Response::from_stream(body)?, meta.etag())
        }

        Method::Put => {
            let mut writer = op.writer_with(&key);
            // Backends without multipart (e.g. WebDAV) accept a single write, so the whole body is buffered.
            let can_multi = op.info().capability().write_can_multi;
            if can_multi {
                writer = writer.chunk(CHUNK);
            }
            if let Some(v) = &if_match {
                writer = writer.if_match(v);
            }
            match if_none_match.as_deref() {
                Some("*") => writer = writer.if_not_exists(true),
                Some(v) => writer = writer.if_none_match(v),
                None => {}
            }
            let mut writer = match writer.await {
                Ok(w) => w,
                Err(e) => return error_response(e),
            };
            if can_multi {
                let mut body = req.stream()?;
                while let Some(chunk) = body.next().await {
                    if let Err(e) = writer.write(chunk?).await {
                        let _ = writer.abort().await;
                        return error_response(e);
                    }
                }
            } else if let Err(e) = writer.write(req.bytes().await?).await {
                return error_response(e);
            }
            match writer.close().await {
                Ok(meta) => with_etag(Response::empty()?.with_status(201), meta.etag()),
                Err(e) => error_response(e),
            }
        }

        Method::Delete => {
            let mut delete = op.delete_with(&key);
            if let Some(v) = &if_match {
                delete = delete.if_match(v);
            }
            match delete.await {
                Ok(()) => Ok(Response::empty()?.with_status(204)),
                Err(e) => error_response(e),
            }
        }

        _ => Response::error("method not allowed", 405),
    }
}
