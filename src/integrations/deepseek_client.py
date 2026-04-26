"""DeepSeek LLM 客户端 - OpenAI 兼容接口"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx
from loguru import logger
from tenacity import retry, stop_after_attempt, wait_exponential
from .circuit_breaker import CircuitBreaker


class DeepSeekClient:
    """
    DeepSeek API 客户端（OpenAI 兼容）。

    文档: https://api-docs.deepseek.com/
    """

    BASE_URL = "https://api.deepseek.com"

    def __init__(
        self,
        api_key: str | None = None,
        model: str = "deepseek-chat",
    ):
        self.api_key = (api_key or os.getenv("DEEPSEEK_API_KEY", "")).strip()
        self.model = model
        self.failure_threshold = int(
            os.getenv("DEEPSEEK_CIRCUIT_FAILURE_THRESHOLD", "3")
        )
        self.recovery_timeout_sec = int(
            os.getenv("DEEPSEEK_CIRCUIT_RECOVERY_TIMEOUT_SEC", "30")
        )
        self.half_open_max_success = int(
            os.getenv("DEEPSEEK_CIRCUIT_HALF_OPEN_MAX_SUCCESS", "1")
        )
        self.circuit_breaker = CircuitBreaker(
            name="DeepSeek",
            failure_threshold=self.failure_threshold,
            recovery_timeout_sec=self.recovery_timeout_sec,
            half_open_max_success=self.half_open_max_success,
        )

        self._client = httpx.AsyncClient(
            timeout=60.0,
            headers={
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            },
        )

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10))
    async def chat(
        self,
        messages: list[dict[str, str]],
        temperature: float = 0.7,
        max_tokens: int = 4096,
        response_format: dict | None = None,
    ) -> str:
        """调用 DeepSeek 聊天接口。"""
        if not self.api_key:
            raise RuntimeError("DEEPSEEK_API_KEY 未配置，无法调用 DeepSeek。")
        self.circuit_breaker.before_request()

        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if response_format:
            payload["response_format"] = response_format

        try:
            response = await self._client.post(
                f"{self.BASE_URL}/v1/chat/completions", json=payload
            )
            response.raise_for_status()
        except Exception:
            self.circuit_breaker.record_failure()
            raise

        data = response.json()
        if "choices" in data and data["choices"]:
            self.circuit_breaker.record_success()
            return data["choices"][0]["message"]["content"]

        logger.error(f"DeepSeek API unexpected response: {data}")
        self.circuit_breaker.record_failure()
        raise ValueError(f"Unexpected API response: {data}")

    async def chat_json(
        self,
        messages: list[dict[str, str]],
        temperature: float = 0.3,
        max_tokens: int = 4096,
    ) -> dict:
        """调用聊天接口并解析 JSON 输出。"""
        text = await self.chat(
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            response_format={"type": "json_object"},
        )
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            start = text.find("{")
            end = text.rfind("}") + 1
            if start >= 0 and end > start:
                return json.loads(text[start:end])
            raise

    async def close(self):
        await self._client.aclose()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        await self.close()
