import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { Err } from '../components'
import { MicRecorder } from '../micRecorder'
import {
  deleteChat, deriveTitle, exportChat, listChats, makeChat,
  parseImportedChat, saveChat, stripAudioForSave,
} from '../chatStore'

// The backend is stateless — /ask sees one question at a time, no thread. A follow-up
// like "and if I wait longer?" only makes sense to the model if we fold the last few
// turns into the question ourselves. Trade-off: this also feeds history into the
// RETRIEVAL embedding, which can blur it for a follow-up that changes topic — a real
// limitation, not hidden here, and exactly what Session 5's persistence work fixes.
const HISTORY_TURNS = 3

function withHistory(history, question) {
  const turns = history.slice(-HISTORY_TURNS)
  if (turns.length === 0) return question
  const transcript = turns.map((t) => `User: ${t.q}\nAssistant: ${t.a}`).join('\n\n')
  return `Previous conversation:\n${transcript}\n\nUser: ${question}`
}

// Every browser tab needs at least one chat to land on — reuse what's saved,
// or start the very first one.
function bootstrapChats() {
  const existing = listChats()
  if (existing.length) return existing
  const fresh = makeChat()
  saveChat(fresh)
  return [fresh]
}

// agent/useRag/useHistory/mode/topK/minScore/sourceFilter now live in App.jsx and are
// configured from the Settings view — Chat only reads them to build each /ask request.
export default function Chat({
  agents, hostedOnly = [], foundry,
  agent, useRag, useHistory, mode, topK, minScore, sourceFilter, ttsVoice, onStatus,
}) {
  const [chats, setChats] = useState(bootstrapChats)
  const [chatId, setChatId] = useState(() => chats[0].id)
  const [messages, setMessages] = useState(() => chats[0].messages)
  const [history, setHistory] = useState(() => chats[0].history)   // [{q, a}] — for multi-turn context
  const [question, setQuestion] = useState('')
  const [voiceMode, setVoiceMode] = useState(false)
  // Which chats have a request in flight — a Set, not a single flag, because Chat is a
  // singleton shared by every chat (it stays mounted across tab switches, see App.jsx).
  // A plain boolean would mean chat A "thinking" also blocks sending in chat B.
  const [busyChatIds, setBusyChatIds] = useState(() => new Set())
  const busy = busyChatIds.has(chatId)
  const [error, setError] = useState(null)
  const [copiedIndex, setCopiedIndex] = useState(null)
  const [speakingIndex, setSpeakingIndex] = useState(null)
  const [clearSnapshot, setClearSnapshot] = useState(null)   // {messages, history} while "undo" is offered
  const [renamingId, setRenamingId] = useState(null)
  const [renameValue, setRenameValue] = useState('')
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const endRef = useRef(null)
  const recorderRef = useRef(null)
  const undoTimerRef = useRef(null)
  const chatIdRef = useRef(chatId)   // lets an in-flight request notice a chat switch after its await

  useEffect(() => { chatIdRef.current = chatId }, [chatId])
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, busy])
  useEffect(() => () => recorderRef.current?.stop(), [])   // release the mic if the view unmounts mid-recording
  useEffect(() => () => clearTimeout(undoTimerRef.current), [])

  // Autosave: every change to the active chat's messages/history is persisted
  // immediately, keyed by whichever chatId is current at the time.
  useEffect(() => {
    setChats((prev) => {
      const current = prev.find((c) => c.id === chatId)
      const savedMessages = messages.map(stripAudioForSave)
      const updated = {
        id: chatId,
        title: deriveTitle(current?.title, savedMessages),
        createdAt: current?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: savedMessages,
        history,
      }
      saveChat(updated)
      return prev.map((c) => (c.id === chatId ? updated : c))
    })
  }, [messages, history, chatId])

  function startNewChat() {
    const fresh = makeChat()
    saveChat(fresh)
    setChats((prev) => [fresh, ...prev])
    setChatId(fresh.id)
    setMessages([]); setHistory([]); setQuestion(''); setError(null)
    setClearSnapshot(null); clearTimeout(undoTimerRef.current)
  }

  function switchChat(id, list = chats) {
    if (id === chatId) return
    const target = list.find((c) => c.id === id)
    if (!target) return
    setChatId(id)
    setMessages(target.messages); setHistory(target.history)
    setQuestion(''); setError(null)
    setClearSnapshot(null); clearTimeout(undoTimerRef.current)   // it belonged to the chat we're leaving
  }

  function handleClear() {
    if (!messages.length) return
    setClearSnapshot({ messages, history })
    setMessages([]); setHistory([])
    clearTimeout(undoTimerRef.current)
    undoTimerRef.current = setTimeout(() => setClearSnapshot(null), 6000)
  }

  function handleUndo() {
    if (!clearSnapshot) return
    setMessages(clearSnapshot.messages); setHistory(clearSnapshot.history)
    setClearSnapshot(null)
    clearTimeout(undoTimerRef.current)
  }

  function removeChat(id, e) {
    e.stopPropagation()
    deleteChat(id)
    const next = chats.filter((c) => c.id !== id)
    setChats(next)
    if (id === chatId) { if (next.length) switchChat(next[0].id, next); else startNewChat() }
  }

  function handleExport(id, e) {
    e.stopPropagation()
    const chat = chats.find((c) => c.id === id)
    if (chat) exportChat(chat)
  }

  function startRename(id, currentTitle, e) {
    e.stopPropagation()
    setRenamingId(id)
    setRenameValue(currentTitle)
  }

  function commitRename(id) {
    const title = renameValue.trim()
    setRenamingId(null)
    if (!title) return
    setChats((prev) => {
      const target = prev.find((c) => c.id === id)
      if (!target) return prev
      const updated = { ...target, title, updatedAt: new Date().toISOString() }
      saveChat(updated)
      return prev.map((c) => (c.id === id ? updated : c))
    })
  }

  // Writes a message straight into a chat's stored record without touching the live
  // messages/history state — for when a request's answer arrives after the user has
  // already switched away from the chat that asked it.
  function appendToChat(id, message, historyEntry) {
    setChats((prev) => {
      const target = prev.find((c) => c.id === id)
      if (!target) return prev   // that chat was deleted while we were waiting
      const updatedMessages = [...target.messages, stripAudioForSave(message)]
      const updated = {
        ...target,
        title: deriveTitle(target.title, updatedMessages),
        updatedAt: new Date().toISOString(),
        messages: updatedMessages,
        history: historyEntry ? [...target.history, historyEntry] : target.history,
      }
      saveChat(updated)
      return prev.map((c) => (c.id === id ? updated : c))
    })
  }

  async function copyAnswer(text, index) {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedIndex(index)
      setTimeout(() => setCopiedIndex((c) => (c === index ? null : c)), 1500)
    } catch (e) { setError(`Could not copy to clipboard: ${e.message}`) }
  }

  // Turns an already-sent answer into audio after the fact — independent of whether
  // `voice replies` was on when it was originally generated.
  async function speakMessage(index) {
    const target = messages[index]
    if (!target || target.role !== 'bot') return
    setSpeakingIndex(index)
    try {
      const blob = await api.speak({ text: target.data.answer, voice: ttsVoice || undefined })
      const audio = { url: URL.createObjectURL(blob), size: blob.size }
      setMessages((m) => m.map((msg, i) => (i === index ? { ...msg, audio, voiceError: undefined } : msg)))
    } catch (e) {
      setMessages((m) => m.map((msg, i) => (i === index ? { ...msg, voiceError: e.message } : msg)))
    } finally {
      setSpeakingIndex(null)
    }
  }

  async function handleImport(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const text = await file.text()
      const imported = parseImportedChat(text, new Set(chats.map((c) => c.id)))
      saveChat(imported)
      const next = [imported, ...chats]
      setChats(next)
      switchChat(imported.id, next)
    } catch (e2) { setError(`Could not import that file (${e2.message}).`) }
  }

  async function toggleRecording() {
    if (recording) {
      setRecording(false)
      setTranscribing(true)
      try {
        const blob = recorderRef.current.stop()
        recorderRef.current = null
        const file = new File([blob], 'question.wav', { type: 'audio/wav' })
        const result = await api.transcribe(file)
        if (result.text?.trim()) await send(result.text)
        else setError('Could not make out any speech in that recording — try again.')
      } catch (e) { setError(e.message) } finally { setTranscribing(false) }
    } else {
      setError(null)
      try {
        recorderRef.current = new MicRecorder()
        await recorderRef.current.start()
        setRecording(true)
      } catch (e) { setError(`Microphone access failed: ${e.message}`) }
    }
  }

  async function send(overrideText, { skipUserMessage = false } = {}) {
    const text = (overrideText ?? question).trim()
    if (!text || busy) return
    // Remember which chat this question belongs to — by the time the response lands,
    // the user may well have switched to a different one (chatIdRef stays current;
    // `chatId` itself would be a stale closure from this render).
    const requestChatId = chatId
    setQuestion(''); setError(null)
    setBusyChatIds((s) => new Set(s).add(requestChatId))
    if (!skipUserMessage) setMessages((m) => [...m, { role: 'user', text }])
    try {
      const sent = useHistory ? withHistory(history, text) : text
      const data = await api.ask({
        // `question` carries history for the prompt; `retrieval_query` is always just the
        // new turn, so an unrelated earlier question doesn't blur what gets retrieved.
        question: sent, retrieval_query: text, use_rag: useRag, top_k: Number(topK), agent, agent_mode: mode,
        min_score: minScore !== '' ? Number(minScore) : undefined,
        filters: sourceFilter.trim() ? { source: sourceFilter.trim() } : undefined,
      })
      const botMsg = { role: 'bot', data }
      if (voiceMode) {
        try {
          const blob = await api.speak({ text: data.answer, voice: ttsVoice || undefined })
          botMsg.audio = { url: URL.createObjectURL(blob), size: blob.size }
        } catch (e) {
          botMsg.voiceError = e.message   // fall back to text, don't lose the answer
        }
      }
      if (chatIdRef.current === requestChatId) {
        setMessages((m) => [...m, botMsg])
        setHistory((h) => [...h, { q: text, a: data.answer }])
      } else {
        appendToChat(requestChatId, botMsg, { q: text, a: data.answer })
      }
    } catch (e) {
      if (chatIdRef.current === requestChatId) {
        setMessages((m) => [...m, { role: 'err', text: e.message }])
        setError(e.message)
      } else {
        appendToChat(requestChatId, { role: 'err', text: e.message })
      }
    } finally {
      setBusyChatIds((s) => { const next = new Set(s); next.delete(requestChatId); return next })
    }
  }

  // Drops the last answer (or error) and re-asks the question that led to it — handy
  // after tweaking Settings, or when the answer just wasn't good. Only ever applies to
  // the last turn: regenerating a mid-conversation answer would strand everything after it.
  function regenerate() {
    if (busy) return
    const last = messages[messages.length - 1]
    if (!last || (last.role !== 'bot' && last.role !== 'err')) return
    let lastUserIndex = -1
    for (let i = messages.length - 2; i >= 0; i--) {
      if (messages[i].role === 'user') { lastUserIndex = i; break }
    }
    if (lastUserIndex === -1) return
    const text = messages[lastUserIndex].text
    setMessages((m) => m.slice(0, lastUserIndex + 1))
    if (last.role === 'bot') setHistory((h) => h.slice(0, -1))   // the stale turn's history entry
    send(text, { skipUserMessage: true })
  }

  // Read-only, just for the orientation badge below — the disabled/legality logic
  // for these lives in the Settings view now, next to the controls that need it.
  const current = [...agents, ...hostedOnly].find((a) => a.name === agent)

  // Every /ask reply already carries the model provider's own exact token count —
  // summing those beats re-tokenizing client-side (no encoding-mismatch guesswork).
  const tokenTotals = messages.reduce((acc, m) => {
    if (m.role === 'bot' && m.data?.usage) {
      acc.in += m.data.usage.prompt_tokens || 0
      acc.out += m.data.usage.completion_tokens || 0
    }
    return acc
  }, { in: 0, out: 0 })

  // Report the summary up to App.jsx, which renders it in the page-title row —
  // Chat still owns the underlying message state, this is just for display.
  useEffect(() => {
    onStatus?.({
      tokensIn: tokenTotals.in,
      tokensOut: tokenTotals.out,
      personaLabel: current ? `${current.display_name} · ${mode}${useRag ? '' : ' · no RAG'}` : null,
    })
    return () => onStatus?.(null)
  }, [tokenTotals.in, tokenTotals.out, current, mode, useRag])   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="chat-shell">
      <aside className="chat-log">
        <button className="btn btn-outline btn-sm" style={{ width: '100%' }} onClick={startNewChat}>+ New chat</button>
        <div className="chat-log-list">
          {chats.map((c) => (
            <div key={c.id} className={`chat-log-item ${c.id === chatId ? 'active' : ''}`}
                 onClick={() => switchChat(c.id)} title={c.title}>
              {renamingId === c.id ? (
                <input
                  className="chat-log-rename-input"
                  value={renameValue}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); commitRename(c.id) }
                    if (e.key === 'Escape') { e.preventDefault(); setRenamingId(null) }
                  }}
                  onBlur={() => commitRename(c.id)}
                />
              ) : (
                <span className="chat-log-title">{c.title}</span>
              )}
              <span className="chat-log-actions">
                <button className="icon-btn" title="Rename" onClick={(e) => startRename(c.id, c.title, e)}>✎</button>
                <button className="icon-btn" title="Export as .json" onClick={(e) => handleExport(c.id, e)}>⬇</button>
                <button className="icon-btn" title="Delete" onClick={(e) => removeChat(c.id, e)}>🗑</button>
              </span>
            </div>
          ))}
        </div>
        <label className="btn btn-outline btn-sm"
               style={{ width: '100%', textTransform: 'none', letterSpacing: 0, margin: 0, padding: '.3em .7em' }}>
          Import .json
          <input type="file" accept="application/json" style={{ display: 'none' }} onChange={handleImport} />
        </label>
      </aside>
    <div className="chat-wrap">
      <div className="chat-bar chat-topbar">
        {/* token count + persona/mode now surface in the page-title row up top — see onStatus */}
        <label className="check" style={{ margin: 0 }} title="Speak replies out loud (Azure AI Speech) instead of showing plain text">
          <input type="checkbox" checked={voiceMode} onChange={(e) => setVoiceMode(e.target.checked)} />
          🔊 voice replies
        </label>
        <button className="btn btn-outline btn-sm" onClick={clearSnapshot ? handleUndo : handleClear}
                title={clearSnapshot ? 'Bring the cleared conversation back' : 'Clear this conversation'}>
          {clearSnapshot ? '↺ undo' : 'clear'}
        </button>
      </div>

      <div className="msgs">
        {messages.length === 0 && (
          <div className="msg bot">
            Bună ziua! Sunt Libra AI, asistentul digital Libra Bank. Vă pot ajuta cu informații
            despre conturi, depozite, dobânzi, taxe și alte servicii ale băncii. Cu ce vă pot fi
            de folos astăzi?
          </div>
        )}

        {messages.map((m, i) => {
          if (m.role === 'user') return <div className="msg user" key={i}>{m.text}</div>
          if (m.role === 'err') return (
            <div className="msg err" key={i}>
              <strong>Request failed:</strong> {m.text}
              {i === messages.length - 1 && (
                <div style={{ marginTop: '.6rem' }}>
                  <button className="btn btn-outline btn-sm" onClick={regenerate} disabled={busy}>↻ try again</button>
                </div>
              )}
            </div>
          )
          const d = m.data
          return (
            <div className="msg bot" key={i}>
              {m.audio ? (
                <>
                  <audio controls autoPlay src={m.audio.url} style={{ width: '100%' }} />
                  <details className="sources" style={{ marginTop: '.5rem' }}>
                    <summary>show transcript</summary>
                    <p style={{ marginTop: '.5rem' }}>{d.answer}</p>
                  </details>
                </>
              ) : (
                <>
                  {d.answer}
                  {m.voiceError && (
                    <p className="err" style={{ margin: '.5rem 0 0', fontSize: '.85rem' }}>
                      Voice synthesis failed ({m.voiceError}) — showing text instead.
                    </p>
                  )}
                  {m.hadAudio && (
                    <p className="faint" style={{ margin: '.5rem 0 0' }}>
                      🔊 originally answered as voice — audio isn't kept across reloads.
                    </p>
                  )}
                </>
              )}
              <div className="msg-meta">
                <button className="btn btn-outline btn-sm" onClick={() => copyAnswer(d.answer, i)}>
                  {copiedIndex === i ? '✓ copied' : '⧉ copy'}
                </button>
                {!m.audio && (
                  <button className="btn btn-outline btn-sm" onClick={() => speakMessage(i)} disabled={speakingIndex === i}>
                    {speakingIndex === i ? <span className="spin" /> : '🔊 speak'}
                  </button>
                )}
                {i === messages.length - 1 && (
                  <button className="btn btn-outline btn-sm" onClick={regenerate} disabled={busy}>↻ regenerate</button>
                )}
                <span className="badge">{d.agent?.display_name || 'agent'}</span>
                <span className={`badge ${d.augmented ? 'gold' : 'muted'}`}>{d.augmented ? 'grounded' : 'no retrieval'}</span>
                <span className="badge muted">{d.agent?.mode}</span>
                <span className="badge muted">{d.model}</span>
                {d.usage && <span className="badge muted">{d.usage.prompt_tokens}↑ {d.usage.completion_tokens}↓ tokens</span>}
                {d.dropped_below_threshold > 0 &&
                  <span className="badge muted">{d.dropped_below_threshold} dropped below threshold</span>}
                {d.security_notes?.length > 0 && (
                  <span className="badge crimson" title={d.security_notes.join('; ')}>⚠ injection blocked</span>
                )}
              </div>
              {d.augmented && (d.retrieved?.length ?? 0) === 0 && (
                <p className="err" style={{ margin: '.5rem 0 0' }}>
                  Nothing relevant found in the knowledge base — the answer above is not grounded
                  in any document, even though RAG was on.
                </p>
              )}
              {d.retrieved?.length > 0 && (
                <details className="sources">
                  <summary>{d.retrieved.length} retrieved passage{d.retrieved.length > 1 ? 's' : ''}</summary>
                  {d.retrieved.map((h, j) => (
                    <div className="src" key={h.id}>
                      <span className="score">[{j + 1}] score {h.score.toFixed(4)} · {h.source}
                        {h.metadata?.effective ? ` · effective ${h.metadata.effective}` : ''}</span>
                      <div>{h.text}</div>
                    </div>
                  ))}
                </details>
              )}
              <details className="sources">
                <summary>the exact prompt that was sent</summary>
                <pre className="out" style={{ marginTop: '.4rem' }}>{`SYSTEM:\n${d.system_prompt}\n\nUSER:\n${d.prompt_sent}`}</pre>
              </details>
            </div>
          )
        })}
        {busy && (
          <div className="msg bot typing-indicator" title="Thinking…">
            <span /><span /><span />
          </div>
        )}
        <div ref={endRef} />
      </div>

      <Err error={error} />
      <div className="composer">
        <textarea value={question} placeholder="Ask Libra AI…  (Enter to send, Shift+Enter for a new line)"
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
        <button className={`btn ${recording ? 'btn-primary' : 'btn-outline'} shrink`} onClick={toggleRecording}
                disabled={busy || transcribing} title={recording ? 'Stop and send' : 'Record a spoken question'}>
          {transcribing ? <span className="spin" /> : recording ? '⏹ stop' : '🎙️'}
        </button>
        <button className="btn btn-primary" onClick={() => send()} disabled={busy || recording || !question.trim()}>Send</button>
      </div>
    </div>
    </div>
  )
}
