#!/usr/bin/env bash
# Smoke test against a running `wrangler dev` (default http://127.0.0.1:8799).
# Prints one line per check; exits non-zero if any fail.
set -u
B=${1:-http://127.0.0.1:8799}
P="smoke-$(date +%s)"
fails=0
curl() { command curl -m 60 "$@"; }

check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: expected '$2', got '$3'"; fails=$((fails + 1)); fi
}
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
etag() { curl -s -D - -o /dev/null "$@" | tr -d '\r' | awk -F': ' 'tolower($1)=="etag"{print $2}'; }

check "PUT new"                      201 "$(status -X PUT --data v1 "$B/$P/a.txt")"
E1=$(etag "$B/$P/a.txt")
check "GET has ETag"                 yes "$([ -n "$E1" ] && echo yes || echo no)"
check "GET body"                     v1 "$(curl -s "$B/$P/a.txt")"
check "GET If-None-Match current"    304 "$(status -H "If-None-Match: $E1" "$B/$P/a.txt")"
check "GET If-None-Match stale"      200 "$(status -H 'If-None-Match: "nope"' "$B/$P/a.txt")"
check "GET If-Match stale"           412 "$(status -H 'If-Match: "nope"' "$B/$P/a.txt")"
check "PUT If-None-Match:* existing" 412 "$(status -X PUT -H 'If-None-Match: *' --data x "$B/$P/a.txt")"
check "PUT If-None-Match:* new"      201 "$(status -X PUT -H 'If-None-Match: *' --data x "$B/$P/new.txt")"
check "PUT If-Match stale"           412 "$(status -X PUT -H 'If-Match: "nope"' --data x "$B/$P/a.txt")"
check "PUT If-Match current"         201 "$(status -X PUT -H "If-Match: $E1" --data v2 "$B/$P/a.txt")"
check "body after conditional PUT"   v2 "$(curl -s "$B/$P/a.txt")"
check "DELETE If-Match stale"        412 "$(status -X DELETE -H 'If-Match: "nope"' "$B/$P/a.txt")"

check "PUT encoded key"              201 "$(status -X PUT --data '{}' "$B/$P/b%20%26%20c%20%C3%A9.json")"
check "list decodes key"             yes "$(curl -s "$B/$P/" | grep -q "b & c é.json" && echo yes || echo no)"

big=$(mktemp)
head -c 12000000 /dev/urandom >"$big"
check "PUT 12 MB (multipart)"        201 "$(status -X PUT -T "$big" "$B/$P/big.bin")"
check "GET 12 MB matches"            yes "$(curl -s "$B/$P/big.bin" | cmp -s - "$big" && echo yes || echo no)"
rm -f "$big"

check "DELETE"                       204 "$(status -X DELETE "$B/$P/a.txt")"
check "GET deleted"                  404 "$(status "$B/$P/a.txt")"
for k in new.txt b%20%26%20c%20%C3%A9.json big.bin; do curl -s -o /dev/null -X DELETE "$B/$P/$k"; done

echo "$fails failed"
exit $((fails > 0))
