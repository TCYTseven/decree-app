import type { PyContext } from "../context.js";
import { docstring } from "./config.js";

export function toolsHttpPy(ctx: PyContext): string {
  return String.raw`${docstring(ctx, "HTTP tools: call an endpoint of the project's own API.")}

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from typing import Any
from urllib.parse import quote

import httpx

from ..config import HTTP_MAX_BODY_CHARS, HTTP_TIMEOUT_S
from .base import ToolResult, to_text, truncate_head

BODY_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
_PATH_PARAM = re.compile(r"\{([^{}]+)\}")


def encode_component(value: Any) -> str:
    """Percent-encode like JavaScript's encodeURIComponent."""
    return quote(to_text(value), safe="!*'()~")


def build_request(binding: Mapping[str, Any], args: Mapping[str, Any]) -> dict[str, Any]:
    """Turn a tool binding plus model input into keyword arguments for httpx.request.

    Raises ValueError with a message meant for the model when the call cannot be built.
    """
    base_env = binding.get("baseUrlEnv") or ""
    base = (os.environ.get(base_env) if base_env else None) or binding.get("defaultBaseUrl")
    if not base:
        raise ValueError(f"No base URL: set the {base_env or 'base URL'} environment variable.")

    consumed: set[str] = set()

    def fill(match: re.Match[str]) -> str:
        name = match.group(1)
        if args.get(name) is None:
            raise ValueError(f"Missing required path parameter: {name}")
        consumed.add(name)
        return encode_component(args[name])

    url = base.rstrip("/") + _PATH_PARAM.sub(fill, binding.get("path") or "")

    params: dict[str, str] = {}
    for key in binding.get("queryParams") or ():
        consumed.add(key)
        if args.get(key) is not None:
            params[key] = to_text(args[key])

    headers: dict[str, str] = {"Accept": "application/json, text/plain;q=0.9, */*;q=0.8"}
    for key in binding.get("headerParams") or ():
        consumed.add(key)
        if args.get(key) is not None:
            headers[key] = to_text(args[key])

    auth = binding.get("auth") or {}
    secret = os.environ.get(auth.get("env") or "", "") if auth.get("env") else ""
    if auth.get("type") == "bearer" and secret:
        headers["Authorization"] = f"Bearer {secret}"
    elif auth.get("type") == "header" and auth.get("header") and secret:
        headers[auth["header"]] = secret

    method = str(binding.get("method") or "GET").upper()
    request: dict[str, Any] = {"method": method, "url": url, "params": params, "headers": headers}
    if method in BODY_METHODS:
        body_param = binding.get("bodyParam")
        if body_param:
            body = args.get(body_param)
        else:
            body = {k: v for k, v in args.items() if k not in consumed}
        if body is not None and body != {}:
            request["json"] = body
    return request


def call_http(binding: Mapping[str, Any], args: Mapping[str, Any]) -> ToolResult:
    """Execute an HTTP tool. Result text is 'HTTP <status> <reason>' then the body."""
    try:
        request = build_request(binding, args)
    except ValueError as exc:
        return ToolResult.error(str(exc))
    try:
        response = httpx.request(**request, timeout=HTTP_TIMEOUT_S, follow_redirects=True)
    except httpx.HTTPError as exc:
        return ToolResult.error(f"HTTP request failed: {type(exc).__name__}: {exc}")
    text = f"HTTP {response.status_code} {response.reason_phrase}\n" + truncate_head(response.text, HTTP_MAX_BODY_CHARS)
    return ToolResult(text, response.status_code >= 400)
`;
}
