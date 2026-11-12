"""
Unified LLM client for the EXL Smart Metering chatbot and Rebooking Agent.

Supports OpenRouter (OpenAI-compatible /chat/completions + tool calling) and
Hugging Face Inference Providers, selected via environment configuration.
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from typing import Any

DEFAULT_OPENROUTER_MODEL = "nvidia/nemotron-3.5-lightning:free"


def resolve_llm_config() -> dict[str, Any]:
    """Resolve active LLM provider configuration (OpenRouter or Hugging Face)."""
    explicit = (os.getenv("LLM_PROVIDER") or "").strip().lower()
    openrouter_key = (os.getenv("OPENROUTER_API_KEY") or "").strip()
    openai_key = (os.getenv("OPENAI_API_KEY") or "").strip()
    hf_token = (
        os.getenv("HF_TOKEN")
        or os.getenv("HF_API_KEY")
        or os.getenv("HUGGINGFACE_API_TOKEN")
        or os.getenv("HUGGINGFACEHUB_API_TOKEN")
        or ""
    ).strip()

    use_openrouter = (
        explicit == "openrouter"
        or (explicit != "huggingface" and (bool(openrouter_key) or openai_key.startswith("sk-or-")))
    )

    if use_openrouter:
        token = openrouter_key or openai_key
        base_url = (os.getenv("OPENROUTER_BASE_URL") or "https://openrouter.ai/api/v1").strip()
        endpoint = (os.getenv("OPENROUTER_ENDPOINT") or f"{base_url.rstrip('/')}/chat/completions").strip()
        model = (os.getenv("OPENROUTER_MODEL") or DEFAULT_OPENROUTER_MODEL).strip()
        return {
            "provider_kind": "openrouter",
            "provider": "openrouter",
            "token": token,
            "base_url": base_url,
            "endpoint": endpoint,
            "model": model,
            "hf_provider": "",
        }

    base_url = (
        os.getenv("HF_CHAT_BASE_URL")
        or os.getenv("HUGGINGFACE_CHAT_BASE_URL")
        or "https://router.huggingface.co/v1"
    ).strip()
    endpoint = (
        os.getenv("HF_CHAT_ENDPOINT")
        or os.getenv("HUGGINGFACE_CHAT_ENDPOINT")
        or f"{base_url.rstrip('/')}/chat/completions"
    ).strip()
    hf_provider = (
        os.getenv("HF_CHAT_PROVIDER")
        or os.getenv("HUGGINGFACE_CHAT_PROVIDER")
        or ""
    ).strip()
    if not hf_provider and hf_token.startswith("sk_"):
        hf_provider = "novita"
    model = (
        os.getenv("HF_CHAT_MODEL")
        or os.getenv("HUGGINGFACE_CHAT_MODEL")
        or "google/gemma-4-31B-it"
    ).strip()
    return {
        "provider_kind": "huggingface",
        "provider": hf_provider or "huggingface",
        "token": hf_token,
        "base_url": base_url,
        "endpoint": endpoint,
        "model": model,
        "hf_provider": hf_provider,
    }


def _post_chat_json(
    endpoint: str,
    headers: dict[str, str],
    payload: dict[str, Any],
    provider_label: str,
    timeout: float,
) -> dict[str, Any]:
    """POST JSON payload to an OpenAI-compatible chat/completions endpoint."""
    current_payload = dict(payload)
    for attempt in range(2):
        req = urllib.request.Request(
            endpoint,
            data=json.dumps(current_payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:400]
            if exc.code == 402 and attempt == 0:
                match = re.search(r"can only afford (\d+)", detail)
                if match:
                    retry_tokens = int(match.group(1)) - 32
                    if 128 <= retry_tokens < int(current_payload.get("max_tokens", 0)):
                        current_payload["max_tokens"] = retry_tokens
                        continue
            raise RuntimeError(f"{provider_label} endpoint returned HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            if "timed out" in str(exc.reason).lower():
                raise TimeoutError(f"{provider_label} request timed out after {timeout}s.") from exc
            raise RuntimeError(f"Could not reach {provider_label} endpoint: {exc.reason}") from exc
        except TimeoutError as exc:
            raise TimeoutError(f"{provider_label} request timed out after {timeout}s.") from exc
    raise RuntimeError(f"{provider_label} request failed after retry.")


def call_chat_completion(
    messages: list[dict[str, Any]],
    *,
    tools: list[dict[str, Any]] | None = None,
    tool_choice: str | None = None,
    timeout: float | None = None,
    max_tokens: int | None = None,
    temperature: float | None = None,
) -> dict[str, Any]:
    """Execute a chat completion request against OpenRouter or Hugging Face."""
    cfg = resolve_llm_config()
    token = cfg["token"]
    kind = cfg["provider_kind"]

    if not token:
        if kind == "openrouter":
            raise RuntimeError("Missing OPENROUTER_API_KEY (or sk-or- OPENAI_API_KEY) on the Flask server.")
        raise RuntimeError("Missing HF_TOKEN, HF_API_KEY, or HUGGINGFACE_API_TOKEN on the Flask server.")

    eff_timeout = float(timeout if timeout is not None else os.getenv("HF_CHAT_TIMEOUT_SECONDS", "45"))
    eff_max_tokens = int(max_tokens if max_tokens is not None else os.getenv("HF_CHAT_MAX_TOKENS", "700"))
    eff_temp = float(temperature if temperature is not None else os.getenv("HF_CHAT_TEMPERATURE", "0.25"))

    if kind == "huggingface" and cfg["hf_provider"]:
        try:
            from huggingface_hub import InferenceClient
        except ImportError as exc:
            raise RuntimeError("Install huggingface_hub from requirements.txt to use HF_CHAT_PROVIDER.") from exc

        client = InferenceClient(provider=cfg["hf_provider"], api_key=token, timeout=eff_timeout)
        kwargs: dict[str, Any] = {
            "model": cfg["model"],
            "messages": messages,
            "max_tokens": eff_max_tokens,
            "temperature": eff_temp,
        }
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = tool_choice or "auto"
        try:
            completion = client.chat.completions.create(**kwargs)
        except TimeoutError as exc:
            raise TimeoutError(f"LLM provider request timed out after {eff_timeout}s.") from exc
        except Exception as exc:
            detail = str(exc)
            if "timed out" in detail.lower() or "timeout" in detail.lower():
                raise TimeoutError(f"LLM provider timed out: {detail}") from exc
            if "401" in detail or "Unauthorized" in detail:
                raise RuntimeError(
                    "Hugging Face/Novita rejected the API key. Check HF_TOKEN and HF_CHAT_PROVIDER."
                ) from exc
            raise RuntimeError(f"Hugging Face provider request failed: {exc}") from exc

        choice = completion.choices[0] if completion.choices else None
        msg = choice.message if choice else None
        raw_calls = getattr(msg, "tool_calls", None) or []
        tool_calls = []
        for idx, tc in enumerate(raw_calls):
            fn = getattr(tc, "function", None)
            tool_calls.append({
                "id": getattr(tc, "id", None) or f"call_{idx}",
                "type": "function",
                "function": {
                    "name": getattr(fn, "name", "") if fn else "",
                    "arguments": getattr(fn, "arguments", "{}") if fn else "{}",
                },
            })
        return {
            "content": (getattr(msg, "content", None) or "").strip(),
            "tool_calls": tool_calls,
        }

    payload: dict[str, Any] = {
        "model": cfg["model"],
        "messages": messages,
        "max_tokens": eff_max_tokens,
        "temperature": eff_temp,
        "stream": False,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = tool_choice or "auto"

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    if kind == "openrouter":
        headers["HTTP-Referer"] = os.getenv("OPENROUTER_SITE_URL", "http://localhost:5000")
        headers["X-Title"] = os.getenv("OPENROUTER_APP_NAME", "EXL IMSERV Smart Metering")
        if (os.getenv("OPENROUTER_REASONING") or "").strip().lower() not in {"1", "true", "yes", "on"}:
            # Keep reasoning off by default so small max_tokens budgets produce final content/tool calls.
            payload["reasoning"] = {"enabled": False}

    data = _post_chat_json(
        endpoint=cfg["endpoint"],
        headers=headers,
        payload=payload,
        provider_label=cfg["provider"].title(),
        timeout=eff_timeout,
    )

    choice = (data.get("choices") or [{}])[0]
    msg = choice.get("message") or {}
    return {
        "content": (msg.get("content") or "").strip(),
        "tool_calls": msg.get("tool_calls") or [],
    }
