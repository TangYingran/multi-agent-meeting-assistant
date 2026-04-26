import { useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'

type StageType =
  | 'connected'
  | 'processing'
  | 'recording'
  | 'transcript'
  | 'summary'
  | 'actions'
  | 'insights'
  | 'followup'
  | 'completed'
  | 'error'
  | 'pong'

type WsEvent = {
  type?: StageType
  message?: string
  data?: unknown
  status?: string
  errors?: string[]
  meeting_id?: string
  [key: string]: unknown
}

type TranscriptSegment = {
  speaker?: string
  text?: string
  start?: number
  end?: number
  confidence?: number
}

type TopicSummary = {
  title?: string
  discussion_points?: string[]
  participants?: string[]
  conclusion?: string
}

type ActionItem = {
  assignee?: string
  task?: string
  deadline?: string
  priority?: string
  context?: string
  jira_issue_key?: string | null
  feishu_task_id?: string | null
}

type SpeakerStats = {
  speaker?: string
  speaking_duration?: number
  speaking_ratio?: number
  segment_count?: number
  word_count?: number
}

type ReportData = Record<string, unknown>

const stageSteps: { key: StageType; label: string; desc: string }[] = [
  { key: 'connected', label: '连接', desc: 'WebSocket' },
  { key: 'transcript', label: '转写', desc: 'WhisperX' },
  { key: 'summary', label: '摘要', desc: 'Summary Agent' },
  { key: 'actions', label: '待办', desc: 'Action Agent' },
  { key: 'insights', label: '洞察', desc: 'Insight Agent' },
  { key: 'completed', label: '完成', desc: 'Follow-up' },
]

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '-'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value, null, 2)
}

function toArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function getRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function getPriorityClass(priority?: string) {
  if (priority === 'high') return 'priority high'
  if (priority === 'medium') return 'priority medium'
  return 'priority low'
}

function App() {
  const [meetingId, setMeetingId] = useState('')
  const [apiBase, setApiBase] = useState('http://localhost:8000')
  const [file, setFile] = useState<File | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [lastMessage, setLastMessage] = useState<WsEvent | null>(null)
  const [report, setReport] = useState<ReportData | null>(null)
  const [wsConnected, setWsConnected] = useState(false)
  const [busy, setBusy] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)

  const wsBase = useMemo(() => {
    const trimmed = apiBase.trim().replace(/\/$/, '')
    return trimmed.startsWith('https://')
      ? trimmed.replace('https://', 'wss://')
      : trimmed.replace('http://', 'ws://')
  }, [apiBase])

  const summary = getRecord(report?.summary)
  const transcript = getRecord(report?.transcript)
  const actions = getRecord(report?.actions)
  const insights = getRecord(report?.insights)
  const followup = getRecord(report?.followup)

  const transcriptSegments = toArray<TranscriptSegment>(transcript.segments)
  const topics = toArray<TopicSummary>(summary.topics)
  const actionItems = toArray<ActionItem>(actions.action_items)
  const speakerStats = toArray<SpeakerStats>(insights.speaker_stats)
  const keywords = toArray<string>(insights.keywords)
  const errors = toArray<string>(report?.errors)

  const currentStage = lastMessage?.type ?? (wsConnected ? 'connected' : undefined)

  const activeStepIndex = useMemo(() => {
    if (report && currentStage === 'completed') return stageSteps.length - 1
    const idx = stageSteps.findIndex((step) => step.key === currentStage)
    return idx >= 0 ? idx : wsConnected ? 0 : -1
  }, [currentStage, report, wsConnected])

  const addLog = (text: string) => {
    setLogs((prev) => [`[${new Date().toLocaleTimeString()}] ${text}`, ...prev])
  }

  const handleCreateMeeting = async () => {
    setBusy(true)
    try {
      const resp = await fetch(`${apiBase}/api/v1/meeting/start`, { method: 'POST' })
      const data = (await resp.json()) as { meeting_id?: string }
      if (data.meeting_id) {
        setMeetingId(data.meeting_id)
        setReport(null)
        setLastMessage(null)
        addLog(`已创建会议: ${data.meeting_id}`)
      } else {
        addLog('创建会议失败：返回结构异常')
      }
    } catch (error) {
      addLog(`创建会议失败: ${String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleConnectWs = () => {
    if (!meetingId.trim()) {
      addLog('请先输入 meeting_id')
      return
    }
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      addLog('WebSocket 已连接，无需重复连接')
      return
    }

    const ws = new WebSocket(`${wsBase}/ws/meeting/${meetingId}`)
    wsRef.current = ws

    ws.onopen = () => {
      setWsConnected(true)
      setLastMessage({ type: 'connected', message: 'WebSocket connected', meeting_id: meetingId })
      addLog('WebSocket 已连接')
    }

    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as WsEvent
        setLastMessage(parsed)

        if (parsed.type === 'completed') {
          addLog(`流程完成，状态: ${String(parsed.status ?? 'completed')}`)
          void handleGetReport()
        } else if (parsed.type === 'error') {
          addLog(`收到错误: ${String(parsed.message ?? '')}`)
        } else {
          addLog(`收到事件: ${String(parsed.type ?? 'unknown')}`)
        }
      } catch {
        addLog(`收到非 JSON 消息: ${String(event.data)}`)
      }
    }

    ws.onerror = () => {
      addLog('WebSocket 连接异常')
    }

    ws.onclose = () => {
      setWsConnected(false)
      wsRef.current = null
      addLog('WebSocket 已断开')
    }
  }

  const handleDisconnectWs = () => {
    wsRef.current?.close()
  }

  const sendWs = (payload: Record<string, string>) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      addLog('WebSocket 未连接')
      return
    }
    wsRef.current.send(JSON.stringify(payload))
    addLog(`发送指令: ${payload.type}`)
  }

  const handleDemo = () => sendWs({ type: 'demo' })
  const handleStop = () => sendWs({ type: 'stop' })
  const handlePing = () => sendWs({ type: 'ping' })

  const handleUpload = async (e: FormEvent) => {
    e.preventDefault()
    if (!meetingId.trim()) {
      addLog('请先输入 meeting_id')
      return
    }
    if (!file) {
      addLog('请先选择音频文件')
      return
    }

    setBusy(true)
    try {
      const formData = new FormData()
      formData.append('file', file)

      const resp = await fetch(`${apiBase}/api/v1/meeting/${meetingId}/upload`, {
        method: 'POST',
        body: formData,
      })
      const data = (await resp.json()) as Record<string, unknown>
      addLog(`上传处理完成: ${String(data.status ?? 'unknown')}`)
      void handleGetReport()
    } catch (error) {
      addLog(`上传失败: ${String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleGetReport = async () => {
    if (!meetingId.trim()) {
      addLog('请先输入 meeting_id')
      return
    }
    try {
      const resp = await fetch(`${apiBase}/api/v1/meeting/${meetingId}/report`)
      const data = (await resp.json()) as ReportData
      setReport(data)
      addLog('已拉取完整报告')
    } catch (error) {
      addLog(`拉取报告失败: ${String(error)}`)
    }
  }

  return (
    <main className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">Multi-Agent Meeting Assistant</p>
          <h1>多Agent智能会议助手</h1>
          <p className="muted">基于 LangGraph + WhisperX + FastAPI 的会议处理控制台</p>
        </div>
        <div className={wsConnected ? 'status-pill online' : 'status-pill'}>
          {wsConnected ? 'WS 已连接' : 'WS 未连接'}
        </div>
      </header>

      <section className="card control-panel">
        <div className="grid two">
          <label>
            API 地址
            <input value={apiBase} onChange={(e) => setApiBase(e.target.value)} />
          </label>
          <label>
            Meeting ID
            <input value={meetingId} onChange={(e) => setMeetingId(e.target.value)} />
          </label>
        </div>

        <div className="row wrap">
          <button onClick={handleCreateMeeting} disabled={busy}>创建会议</button>
          <button onClick={handleConnectWs} disabled={busy || wsConnected}>连接 WS</button>
          <button onClick={handleDisconnectWs} disabled={!wsConnected}>断开 WS</button>
          <button onClick={handleDemo} disabled={!wsConnected || busy}>运行 demo</button>
          <button onClick={handleStop} disabled={!wsConnected || busy}>stop 处理</button>
          <button onClick={handlePing} disabled={!wsConnected || busy}>ping</button>
          <button onClick={handleGetReport} disabled={busy}>拉取报告</button>
        </div>

        <form className="upload-row" onSubmit={handleUpload}>
          <input
            type="file"
            accept=".wav,.mp3,.m4a,.ogg,.webm,.flac"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <button type="submit" disabled={busy}>上传音频并处理</button>
        </form>
      </section>

      <section className="card">
        <div className="section-head">
          <h2>处理流程</h2>
          <span className="muted">Pipeline + Fan-out/Fan-in</span>
        </div>
        <div className="steps">
          {stageSteps.map((step, idx) => (
            <div
              key={step.key}
              className={`step ${idx <= activeStepIndex ? 'active' : ''} ${idx < activeStepIndex ? 'done' : ''}`}
            >
              <div className="step-dot">{idx < activeStepIndex ? '✓' : idx + 1}</div>
              <div>
                <strong>{step.label}</strong>
                <span>{step.desc}</span>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="stats-grid">
        <div className="stat-card">
          <span>转写片段</span>
          <strong>{transcriptSegments.length}</strong>
        </div>
        <div className="stat-card">
          <span>会议议题</span>
          <strong>{topics.length}</strong>
        </div>
        <div className="stat-card">
          <span>待办事项</span>
          <strong>{actionItems.length}</strong>
        </div>
        <div className="stat-card">
          <span>效率评分</span>
          <strong>{formatValue(insights.efficiency_score)}/10</strong>
        </div>
      </section>

      <section className="layout">
        <div className="left-col">
          <section className="card">
            <div className="section-head">
              <h2>会议摘要</h2>
              <span className="muted">{formatValue(summary.date)}</span>
            </div>
            {!report?.summary ? (
              <p className="muted">暂无摘要</p>
            ) : (
              <>
                <h3 className="report-title">{formatValue(summary.title)}</h3>
                <p><strong>参会人：</strong>{toArray<string>(summary.participants).join('、') || '-'}</p>

                <div className="topic-list">
                  {topics.map((topic, idx) => (
                    <div key={`${topic.title}-${idx}`} className="topic-card">
                      <h4>议题 {idx + 1}：{topic.title}</h4>
                      <ul>
                        {toArray<string>(topic.discussion_points).map((pt, i) => (
                          <li key={`${topic.title}-${i}`}>{pt}</li>
                        ))}
                      </ul>
                      {topic.conclusion && <p><strong>结论：</strong>{topic.conclusion}</p>}
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>

          <section className="card">
            <div className="section-head">
              <h2>待办事项</h2>
              <span className="muted">Action Agent</span>
            </div>
            {actionItems.length === 0 ? (
              <p className="muted">暂无待办</p>
            ) : (
              <div className="action-list">
                {actionItems.map((item, idx) => (
                  <div key={`${item.assignee}-${item.task}-${idx}`} className="action-card">
                    <div className="action-top">
                      <strong>{item.assignee || '未指定'}</strong>
                      <span className={getPriorityClass(item.priority)}>{item.priority || 'normal'}</span>
                    </div>
                    <p>{item.task || '-'}</p>
                    <div className="action-meta">
                      <span>截止：{item.deadline || '-'}</span>
                      <span>Jira：{item.jira_issue_key || '未同步'}</span>
                      <span>飞书：{item.feishu_task_id || '未同步'}</span>
                    </div>
                    {item.context && <p className="muted small">{item.context}</p>}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="card">
            <div className="section-head">
              <h2>会议洞察</h2>
              <span className="muted">Insight Agent</span>
            </div>
            {!report?.insights ? (
              <p className="muted">暂无洞察</p>
            ) : (
              <>
                <div className="insight-grid">
                  <div className="mini-card">
                    <span>整体情绪</span>
                    <strong>{formatValue(insights.overall_sentiment)}</strong>
                  </div>
                  <div className="mini-card">
                    <span>情绪得分</span>
                    <strong>{formatValue(insights.sentiment_score)}</strong>
                  </div>
                </div>

                <p><strong>关键词：</strong>{keywords.join('、') || '-'}</p>

                <div className="speaker-list">
                  {speakerStats.map((s, idx) => (
                    <div key={`${s.speaker}-${idx}`} className="speaker-row">
                      <span>{s.speaker || 'Unknown'}</span>
                      <div className="speaker-bar">
                        <i style={{ width: `${Math.min((s.speaking_ratio ?? 0) * 100, 100)}%` }} />
                      </div>
                      <em>{((s.speaking_ratio ?? 0) * 100).toFixed(1)}%</em>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
        </div>

        <aside className="right-col">
          <section className="card">
            <h2>最近事件</h2>
            {!lastMessage ? (
              <p className="muted">暂无事件</p>
            ) : (
              <div className="event-box">
                <strong>{lastMessage.type || 'unknown'}</strong>
                <p>{lastMessage.message || '流程状态更新'}</p>
                <span>状态：{lastMessage.status || '-'}</span>
              </div>
            )}
          </section>

          <section className="card">
            <h2>会后跟进</h2>
            {!report?.followup ? (
              <p className="muted">暂无跟进结果</p>
            ) : (
              <div className="info-list">
                <div className="info-item">
                  <span>纪要推送</span>
                  <strong>{String(followup.summary_sent ?? false)}</strong>
                </div>
                <div className="info-item">
                  <span>提醒数量</span>
                  <strong>{formatValue(followup.reminders_scheduled)}</strong>
                </div>
                <div className="info-item">
                  <span>报告地址</span>
                  <strong>{formatValue(followup.report_url)}</strong>
                </div>
              </div>
            )}
          </section>

          <section className="card log-card">
            <h2>运行日志</h2>
            <ul className="logs">
              {logs.length === 0 ? <li className="muted">暂无日志</li> : logs.map((line) => <li key={line}>{line}</li>)}
            </ul>
          </section>
        </aside>
      </section>

      <section className="card">
        <div className="section-head">
          <h2>转写时间轴</h2>
          <span className="muted">Transcription Agent</span>
        </div>
        {transcriptSegments.length === 0 ? (
          <p className="muted">暂无转写结果</p>
        ) : (
          <div className="timeline">
            {transcriptSegments.map((seg, idx) => (
              <div key={`${seg.speaker}-${idx}`} className="timeline-item">
                <div className="timeline-head">
                  <strong>{seg.speaker || 'Unknown'}</strong>
                  <span>{seg.start ?? 0}s - {seg.end ?? 0}s</span>
                </div>
                <p>{seg.text || ''}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      {errors.length > 0 && (
        <section className="card report-error">
          <h2>错误信息</h2>
          <ul>
            {errors.map((err) => <li key={err}>{err}</li>)}
          </ul>
        </section>
      )}
    </main>
  )
}

export default App