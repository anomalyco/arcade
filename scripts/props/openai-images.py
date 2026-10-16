"""Runs OpenAI image generations for scripts/props/source-images.ts.

Reads {"model", "size", "quality", "jobs": [{"id", "prompt"}]} on stdin and prints one JSON line per job:
{"id", "b64"} or {"id", "error"}. Runs on pro over ssh; the key comes from the environment or the spec on stdin. Standard library only.
"""

import concurrent.futures
import json
import os
import sys
import urllib.request

spec = json.load(sys.stdin)
key = os.environ.get("OPENAI_API_KEY") or spec.pop("key")


def run(job):
    body = json.dumps({
        "model": spec["model"],
        "prompt": job["prompt"],
        "size": spec["size"],
        "quality": spec["quality"],
        "n": 1,
    }).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/images/generations",
        data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=600) as res:
            data = json.load(res)
        return {"id": job["id"], "b64": data["data"][0]["b64_json"]}
    except urllib.error.HTTPError as e:
        return {"id": job["id"], "error": f"{e.code} {e.read().decode()[:400]}"}
    except Exception as e:  # noqa: BLE001
        return {"id": job["id"], "error": str(e)[:400]}


with concurrent.futures.ThreadPoolExecutor(max_workers=spec.get("parallel", 6)) as pool:
    for result in pool.map(run, spec["jobs"]):
        print(json.dumps(result), flush=True)
