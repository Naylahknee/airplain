#!/usr/bin/env python3
"""Deploy AirPlain worker + new landing page via direct upload.

Steps: asset manifest -> upload session -> upload missing assets ->
PUT worker script (all modules) with assets JWT and ALL bindings.
"""
import base64
import hashlib
import io
import json
import mimetypes
import pathlib
import sys
import urllib.request
import uuid

sys.path.insert(0, "/opt/hatch/skills/skill-creator/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

API = "https://api.cloudflare.com/client/v4"
CREDENTIAL = "custom.cloudflare"
ALLOWED = ["api.cloudflare.com"]
ACCOUNT = "f6341f77b5dfbd56589d1cd68f38c2d8"
SCRIPT = "airplain"
PROJECT = pathlib.Path("/home/hatch/workspace/airplain")
D1_ID = "480edd18-d14b-47ea-96ea-637d14d0404f"


def call(method, path, body=None, raw_body=None, content_type=None, bearer=None):
    req = urllib.request.Request(API + path, method=method)
    req.add_header(
        "User-Agent",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    )
    if bearer:
        req.add_header("Authorization", f"Bearer {bearer}")
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        req.add_header("Content-Type", "application/json")
        req.data = data
    elif raw_body is not None:
        req.add_header("Content-Type", content_type)
        req.data = raw_body
    if not bearer:
        add_surrogate_to_request(req, CREDENTIAL, allowed_hosts=ALLOWED)
    with urllib.request.urlopen(req, timeout=120) as resp:
        return read_json_response(resp)


def check(res, label):
    if not res.get("success"):
        raise RuntimeError(f"{label} failed: {json.dumps(res.get('errors', res), indent=2)[:2000]}")
    return res.get("result")


def asset_hash(data: bytes, ext: str) -> str:
    # Verified formula: sha256 of base64(file bytes) + file extension, 32 hex chars.
    return hashlib.sha256((base64.b64encode(data).decode() + ext).encode()).hexdigest()[:32]


def multipart(fields, files):
    boundary = "----cf" + uuid.uuid4().hex
    buf = io.BytesIO()
    for name, (ctype, value) in fields.items():
        buf.write(f"--{boundary}\r\n".encode())
        buf.write(f'Content-Disposition: form-data; name="{name}"\r\n'.encode())
        buf.write(f"Content-Type: {ctype}\r\n\r\n".encode())
        buf.write(value if isinstance(value, bytes) else value.encode())
        buf.write(b"\r\n")
    for name, (filename, ctype, value) in files.items():
        buf.write(f"--{boundary}\r\n".encode())
        buf.write(
            f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'.encode()
        )
        buf.write(f"Content-Type: {ctype}\r\n\r\n".encode())
        buf.write(value)
        buf.write(b"\r\n")
    buf.write(f"--{boundary}--\r\n".encode())
    return buf.getvalue(), f"multipart/form-data; boundary={boundary}"


def main():
    # 1. Build manifest for site/ assets.
    site = PROJECT / "site"
    manifest = {}
    blobs = {}
    for f in sorted(site.rglob("*")):
        if not f.is_file():
            continue
        rel = "/" + f.relative_to(site).as_posix()
        data = f.read_bytes()
        ext = f.suffix  # e.g. ".html"
        h = asset_hash(data, ext)
        manifest[rel] = {"hash": h, "size": len(data)}
        blobs[h] = (data, mimetypes.guess_type(f.name)[0] or "application/octet-stream")
    print("manifest:", json.dumps(manifest))

    # 2. Upload session.
    res = check(
        call("POST", f"/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}/assets-upload-session",
             {"manifest": manifest}),
        "assets-upload-session",
    )
    upload_jwt = res["jwt"]
    buckets = res.get("buckets", [])
    missing = [h for b in buckets for h in b]
    print(f"upload jwt acquired; buckets: {len(buckets)}, missing hashes: {len(missing)}")

    # 3. Upload missing assets as multipart, authed by the session JWT.
    #    The final upload response carries the completion JWT.
    completion_jwt = upload_jwt
    for b in buckets:
        parts = {}
        for h in b:
            data, ctype = blobs[h]
            parts[h] = (h, ctype, base64.b64encode(data))
        body, ctype = multipart({}, parts)
        res = check(call("POST", f"/accounts/{ACCOUNT}/workers/assets/upload?base64=true",
                         raw_body=body, content_type=ctype, bearer=upload_jwt),
                    f"asset upload bucket {b}")
        if res.get("jwt"):
            completion_jwt = res["jwt"]
        print(f"uploaded bucket of {len(b)} asset(s)")
    print("completion jwt acquired:", completion_jwt[:20] + "...")

    # 4. PUT worker script: metadata + all modules. ALL bindings included.
    metadata = {
        "main_module": "worker.js",
        "compatibility_date": "2026-10-01",
        "assets": {"jwt": completion_jwt},
        "bindings": [
            {"type": "assets", "name": "ASSETS"},
            {"type": "d1", "name": "AIRPLAIN_DB", "id": D1_ID},
            {"type": "plain_text", "name": "ENGINE", "text": "workers-ai"},
            {"type": "ai", "name": "AI"},
        ],
    }
    src = PROJECT / "src"
    files = {}
    for mod in ["worker.js", "guardrails.js", "engine.js", "store.js", "paperTrail.js", "calibration.js"]:
        files[mod] = (mod, "application/javascript+module", (src / mod).read_bytes())
    body, ctype = multipart({"metadata": ("application/json", json.dumps(metadata))}, files)
    res = check(call("PUT", f"/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}",
                     raw_body=body, content_type=ctype), "script upload")
    print("deployed:", json.dumps({k: res.get(k) for k in ("id", "etag", "modified_on")}, indent=2))


if __name__ == "__main__":
    main()
