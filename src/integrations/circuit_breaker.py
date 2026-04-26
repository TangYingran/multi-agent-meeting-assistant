"""通用熔断器（支持同步/异步客户端复用）。"""

from __future__ import annotations

import time
from enum import Enum

from loguru import logger


class CircuitState(str, Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


class CircuitBreaker:
    """简单熔断器：CLOSED -> OPEN -> HALF_OPEN -> CLOSED。"""

    def __init__(
        self,
        name: str,
        failure_threshold: int = 3,
        recovery_timeout_sec: int = 30,
        half_open_max_success: int = 1,
    ):
        self.name = name
        self.failure_threshold = max(failure_threshold, 1)
        self.recovery_timeout_sec = max(recovery_timeout_sec, 1)
        self.half_open_max_success = max(half_open_max_success, 1)

        self._state = CircuitState.CLOSED
        self._failure_count = 0
        self._opened_at = 0.0
        self._half_open_success_count = 0

    def before_request(self) -> None:
        """请求前检查是否允许放行。"""
        if self._state != CircuitState.OPEN:
            return

        elapsed = time.time() - self._opened_at
        if elapsed >= self.recovery_timeout_sec:
            self._state = CircuitState.HALF_OPEN
            self._half_open_success_count = 0
            logger.warning(f"{self.name} circuit -> HALF_OPEN (start probing)")
            return

        raise RuntimeError(
            f"{self.name} circuit is OPEN, retry after "
            f"{max(int(self.recovery_timeout_sec - elapsed), 1)}s"
        )

    def record_success(self) -> None:
        """记录一次成功调用。"""
        self._failure_count = 0
        if self._state == CircuitState.HALF_OPEN:
            self._half_open_success_count += 1
            if self._half_open_success_count >= self.half_open_max_success:
                self._state = CircuitState.CLOSED
                self._half_open_success_count = 0
                logger.info(f"{self.name} circuit -> CLOSED")

    def record_failure(self) -> None:
        """记录一次失败调用。"""
        self._failure_count += 1
        if self._state == CircuitState.HALF_OPEN:
            self._state = CircuitState.OPEN
            self._opened_at = time.time()
            self._half_open_success_count = 0
            logger.warning(f"{self.name} circuit HALF_OPEN failed -> OPEN")
            return

        if self._failure_count >= self.failure_threshold:
            self._state = CircuitState.OPEN
            self._opened_at = time.time()
            logger.warning(f"{self.name} circuit CLOSED failed -> OPEN")
