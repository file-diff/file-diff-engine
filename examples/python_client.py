#!/usr/bin/env python3
"""Sample Python client for the File Diff Engine OpenAPI endpoints."""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


class FileDiffEngineClient:
    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")

    def health(self) -> dict[str, Any]:
        return self._request_json("GET", "/api/health")

    def version(self) -> dict[str, Any]:
        return self._request_json("GET", "/api/version")

    def resolve_ref(self, repo: str, ref: str) -> dict[str, Any]:
        return self._request_json("POST", "/api/jobs/resolve", {"repo": repo, "ref": ref})

    def resolve_pull_request(self, pull_request_url: str) -> dict[str, Any]:
        return self._request_json(
            "POST",
            "/api/jobs/pull-request/resolve",
            {"pullRequestUrl": pull_request_url},
        )

    def list_refs(self, repo: str) -> dict[str, Any]:
        return self._request_json("POST", "/api/jobs/refs", {"repo": repo})

    def list_organization_repositories(self, organization: str) -> dict[str, Any]:
        encoded_organization = urllib.parse.quote(organization, safe="")
        return self._request_json(
            "GET", f"/api/jobs/organizations/{encoded_organization}/repositories"
        )

    def create_job(self, repo: str, commit: str) -> dict[str, Any]:
        return self._request_json("POST", "/api/jobs", {"repo": repo, "commit": commit})

    def get_job(self, job_id: str) -> dict[str, Any]:
        encoded_job_id = urllib.parse.quote(job_id, safe="")
        return self._request_json("GET", f"/api/jobs/{encoded_job_id}")

    def get_job_files(self, job_id: str) -> dict[str, Any]:
        encoded_job_id = urllib.parse.quote(job_id, safe="")
        return self._request_json("GET", f"/api/jobs/{encoded_job_id}/files")

    def tokenize_file(self, blob_hash: str) -> dict[str, Any]:
        encoded_hash = urllib.parse.quote(blob_hash, safe="")
        return self._request_json("GET", f"/api/jobs/files/hash/{encoded_hash}/tokenize")

    def diff_files(self, left_hash: str, right_hash: str) -> dict[str, Any]:
        encoded_left_hash = urllib.parse.quote(left_hash, safe="")
        encoded_right_hash = urllib.parse.quote(right_hash, safe="")
        return self._request_json(
            "GET",
            f"/api/jobs/files/hash/{encoded_left_hash}/diff/{encoded_right_hash}",
        )

    def download_file(self, job_id: str, blob_hash: str) -> bytes:
        encoded_job_id = urllib.parse.quote(job_id, safe="")
        encoded_hash = urllib.parse.quote(blob_hash, safe="")
        return self._request_bytes(
            "GET",
            f"/api/jobs/{encoded_job_id}/files/hash/{encoded_hash}/download",
        )

    def _request_json(
        self, method: str, endpoint: str, payload: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        response = self._request(method, endpoint, payload)
        if not response:
            return {}
        return json.loads(response.decode("utf-8"))

    def _request_bytes(
        self, method: str, endpoint: str, payload: dict[str, Any] | None = None
    ) -> bytes:
        return self._request(method, endpoint, payload)

    def _request(
        self, method: str, endpoint: str, payload: dict[str, Any] | None = None
    ) -> bytes:
        url = f"{self.base_url}{endpoint}"
        data = None
        headers = {"accept": "application/json"}

        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["content-type"] = "application/json"

        request = urllib.request.Request(url, data=data, headers=headers, method=method)

        try:
            with urllib.request.urlopen(request) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            details = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Request failed with status {error.code}: {details}") from error


if __name__ == "__main__":
    client = FileDiffEngineClient("http://localhost:12986")

    print("Health:")
    print(client.health())

    print("\nVersion:")
    print(client.version())
