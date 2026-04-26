"""
核心数据模型定义（Pydantic Schema）

该文件统一定义多 Agent 会议流水线使用的状态与结构化结果模型。
"""

from __future__ import annotations

from enum import Enum
from typing import TypedDict

from pydantic import BaseModel, Field


class MeetingStatus(str, Enum):
    """会议处理状态枚举。"""

    CREATED = "created"
    TRANSCRIBING = "transcribing"
    COMPLETED = "completed"


class Priority(str, Enum):
    """待办优先级。"""

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    URGENT = "urgent"


class SentimentType(str, Enum):
    """会议整体情绪类型。"""

    POSITIVE = "positive"
    NEUTRAL = "neutral"
    NEGATIVE = "negative"


class TranscriptSegment(BaseModel):
    """单条转写片段。"""

    speaker: str = "Unknown"
    text: str = ""
    start: float = 0.0
    end: float = 0.0
    confidence: float = 0.0


class TranscriptResult(BaseModel):
    """完整转写结果。"""

    meeting_id: str
    segments: list[TranscriptSegment] = Field(default_factory=list)
    language: str = "zh"
    duration_seconds: float = 0.0
    full_text: str = ""


class TopicSummary(BaseModel):
    """单个议题摘要。"""

    title: str
    discussion_points: list[str] = Field(default_factory=list)
    participants: list[str] = Field(default_factory=list)
    conclusion: str = ""


class MeetingSummary(BaseModel):
    """会议摘要结构。"""

    title: str = "会议纪要"
    date: str = ""
    participants: list[str] = Field(default_factory=list)
    topics: list[TopicSummary] = Field(default_factory=list)
    decisions: list[str] = Field(default_factory=list)
    next_steps: list[str] = Field(default_factory=list)


class ActionItem(BaseModel):
    """单个行动项。"""

    assignee: str = "未指定"
    task: str = ""
    deadline: str = ""
    priority: Priority = Priority.MEDIUM
    context: str = ""
    jira_issue_key: str | None = None
    feishu_task_id: str | None = None


class ActionResult(BaseModel):
    """行动项聚合结果。"""

    meeting_id: str
    action_items: list[ActionItem] = Field(default_factory=list)
    sync_status: dict[str, str] = Field(default_factory=dict)


class SpeakerStats(BaseModel):
    """发言人统计信息。"""

    speaker: str
    speaking_duration: float = 0.0
    speaking_ratio: float = 0.0
    word_count: int = 0
    segment_count: int = 0


class MeetingInsight(BaseModel):
    """会议洞察结果。"""

    meeting_id: str
    overall_sentiment: SentimentType = SentimentType.NEUTRAL
    sentiment_score: float = 0.5
    speaker_stats: list[SpeakerStats] = Field(default_factory=list)
    efficiency_score: float = 5.0
    keywords: list[str] = Field(default_factory=list)
    highlights: list[str] = Field(default_factory=list)
    suggestions: list[str] = Field(default_factory=list)


class FollowUpResult(BaseModel):
    """会后跟进结果。"""

    meeting_id: str
    summary_sent: bool = False
    recipients: list[str] = Field(default_factory=list)
    jira_issues_created: list[str] = Field(default_factory=list)
    feishu_tasks_created: list[str] = Field(default_factory=list)
    reminders_scheduled: int = 0
    report_url: str = ""


class MeetingState(TypedDict, total=False):
    """LangGraph 共享状态定义。"""

    meeting_id: str
    status: str
    audio_data: bytes
    transcript: TranscriptResult
    transcript_text: str
    summary: MeetingSummary
    actions: ActionResult
    insights: MeetingInsight
    followup: FollowUpResult
    errors: list[str]


def create_initial_state(meeting_id: str, audio_data: bytes = b"") -> MeetingState:
    """
    创建流水线初始状态。

    Args:
        meeting_id: 会议唯一标识
        audio_data: 原始音频字节

    Returns:
        可供 LangGraph ainvoke 的初始状态字典
    """
    return {
        "meeting_id": meeting_id,
        "status": MeetingStatus.CREATED.value,
        "audio_data": audio_data,
        "transcript_text": "",
        "errors": [],
    }
