"""
Tiny TLS-impersonation HTTP helper invoked by Bun via stdin/stdout JSON.

`https://janitorai.com/generateAlpha` is gated by a Cloudflare WAF rule that
fingerprints the TLS handshake (JA3). Bun's native fetch and stock curl both
get a 403 there. `curl_cffi` (a thin wrapper around libcurl-impersonate) can
emit a byte-identical Chrome ClientHello and passes the rule.

This script intentionally has no CLI surface — it speaks one JSON request in,
one JSON response out, so the Bun side can pipe arbitrary requests through it
without re-encoding shell arguments.

Request shape (stdin, single JSON line/blob):
    {
      "method": "POST",
      "url":    "https://janitorai.com/generateAlpha",
      "headers": { ... },
      "body":    "<string>"     // optional
      "timeout": 45             // optional, seconds
    }

Response shape (stdout, single JSON blob):
    {
      "status":  200,
      "headers": { ... },
      "body":    "<string>"
    }

On error: { "error": "<message>" } with non-zero exit code.

Requires:  pip install curl_cffi
"""
from __future__ import annotations

import json
import sys


def main() -> int:
    try:
        from curl_cffi import requests as cffi
    except ImportError:
        print(json.dumps({
            "error": "curl_cffi not installed. Run: pip3 install curl_cffi"
        }))
        return 2

    try:
        req = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"invalid JSON input: {e}"}))
        return 2

    url = req.get("url")
    if not url:
        print(json.dumps({"error": "missing 'url'"}))
        return 2

    method = (req.get("method") or "GET").upper()
    headers = req.get("headers") or {}
    body = req.get("body")
    timeout = req.get("timeout", 45)
    impersonate = req.get("impersonate", "chrome")

    try:
        r = cffi.request(
            method,
            url,
            headers=headers,
            data=body if isinstance(body, (str, bytes)) else (
                None if body is None else json.dumps(body)
            ),
            timeout=timeout,
            impersonate=impersonate,
        )
    except Exception as e:
        print(json.dumps({"error": f"request failed: {type(e).__name__}: {e}"}))
        return 1

    print(json.dumps({
        "status": r.status_code,
        "headers": dict(r.headers),
        "body": r.text,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
