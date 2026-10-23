//! Throwaway: can OpenDAL's S3 service run inside a Cloudflare Worker?
//! GET/PUT/DELETE /<key> map straight to the bucket.
use opendal::{Operator, services::S3};
use worker::*;

fn operator(env: &Env) -> Result<Operator> {
    // `#[ctor]` doesn't run on wasm32, so install the reqwest (fetch) transport by hand.
    opendal::install_default();
    let var = |k: &str| env.var(k).map(|v| v.to_string());
    let builder = S3::default()
        .endpoint(&var("S3_ENDPOINT")?)
        .bucket(&var("S3_BUCKET")?)
        .region(&var("S3_REGION")?)
        .access_key_id(&var("S3_ACCESS_KEY_ID")?)
        .secret_access_key(&var("S3_SECRET_ACCESS_KEY")?)
        .disable_config_load()
        .disable_ec2_metadata();
    Ok(Operator::new(builder).map_err(err)?)
}

fn err(e: opendal::Error) -> Error {
    Error::RustError(e.to_string())
}

#[event(fetch)]
async fn fetch(mut req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let op = operator(&env)?;
    let key = req.path().trim_start_matches('/').to_string();
    match req.method() {
        Method::Get if key.is_empty() || key.ends_with('/') => {
            let names: Vec<String> = op.list(&key).await.map_err(err)?.into_iter().map(|e| e.path().to_string()).collect();
            Response::from_json(&names)
        }
        Method::Get => match op.read(&key).await {
            Ok(buf) => Response::from_bytes(buf.to_vec()),
            Err(e) if e.kind() == opendal::ErrorKind::NotFound => Response::error("not found", 404),
            Err(e) => Err(err(e)),
        },
        Method::Put => {
            let body = req.bytes().await?;
            let meta = op.write(&key, body).await.map_err(err)?;
            Response::ok(format!("etag={:?}", meta.etag()))
        }
        Method::Delete => {
            op.delete(&key).await.map_err(err)?;
            Response::empty()
        }
        _ => Response::error("method not allowed", 405),
    }
}
