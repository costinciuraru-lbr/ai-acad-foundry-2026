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

// The little figure standing at the desk — waves when you land on a chat, puts a
// hand to the chin while the request is in flight, "talks" once the reply lands,
// and settles back to idle the moment you start typing the next question.
function DeskPerson({ pose }) {
  return (
    <div className="desk-person-wrap">
      <svg className={`desk-person pose-${pose}`} viewBox="0 0 120 120" width="72" height="72"
           shapeRendering="crispEdges" aria-hidden="true">
        <g transform="translate(10,0)">
          {/* torso — blocky shoulders + straight-sided suit, no curves */}
          <rect x="26" y="54" width="48" height="8" className="db-body" />
          <rect x="32" y="62" width="36" height="46" className="db-body" />
          <rect x="38" y="54" width="8" height="10" className="db-collar" />
          <rect x="54" y="54" width="8" height="10" className="db-collar" />
          <rect x="46" y="54" width="8" height="30" className="db-tie" />

          {/* left arm — static */}
          <g>
            <rect x="20" y="58" width="8" height="30" className="db-limb" />
            <rect x="20" y="84" width="8" height="4" className="db-cuff" />
            <rect x="20" y="88" width="8" height="8" className="db-hand" />
          </g>

          <rect x="44" y="46" width="12" height="8" className="db-skin" />

          <g className="db-head-grp">
            <rect x="34" y="2" width="32" height="14" className="db-hat" />
            <rect x="26" y="16" width="48" height="4" className="db-hat" />
            <rect x="30" y="14" width="40" height="4" className="db-hat-band" />
            <rect x="34" y="18" width="32" height="28" className="db-skin" />
            <rect x="40" y="30" width="4" height="4" className="db-eye" />
            <rect x="56" y="30" width="4" height="4" className="db-eye" />
            <rect x="43" y="40" width="3" height="2" className="db-mouth-corner" />
            <rect x="54" y="40" width="3" height="2" className="db-mouth-corner" />
            <rect x="45" y="42" width="10" height="2" className="db-mouth-closed" />
            <rect x="45" y="42" width="10" height="4" className="db-mouth-open" />
          </g>

          {/* right arm — drawn last (after the head) so it, and the magnifying glass, overlay
              the face instead of disappearing behind it whenever it swings up close */}
          <g className="db-arm-r">
            <rect x="72" y="58" width="8" height="30" className="db-limb" />
            <rect x="72" y="84" width="8" height="4" className="db-cuff" />
            <rect x="72" y="88" width="8" height="8" className="db-hand" />
            {/* held by the handle (grips right where the hand is) — the lens sits further out
                along the same arm axis, so raising the arm brings the lens, not the handle,
                up to the face */}
            <g className="db-glass">
              <rect x="75" y="93" width="2" height="9" className="db-glass-handle" />
              <rect x="70" y="100" width="12" height="12" className="db-glass-rim" />
              <rect x="72" y="102" width="8" height="8" className="db-glass-lens" />
            </g>
          </g>
        </g>

        {/* the little counter he sits behind — drawn last so it covers his lower half */}
        <rect x="0" y="98" width="120" height="6" className="db-desk-top" />
        <rect x="0" y="104" width="120" height="16" className="db-desk-front" />
        <rect x="20" y="104" width="4" height="16" className="db-desk-grain" />
        <rect x="56" y="104" width="4" height="16" className="db-desk-grain" />
        <rect x="92" y="104" width="4" height="16" className="db-desk-grain" />
      </svg>
    </div>
  )
}

// A real desk greeter's "good morning/afternoon/evening" changes with the clock —
// the static Romanian greeting below now does the same, read once per mount.
function timeGreeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Bună dimineața'
  if (h < 19) return 'Bună ziua'
  return 'Bună seara'
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
  const [pose, setPose] = useState('wave')   // 'wave' | 'idle' | 'think' | 'talk' | 'shake' | 'inspect' — the desk figure's current pose
  const endRef = useRef(null)
  const recorderRef = useRef(null)
  const undoTimerRef = useRef(null)
  const poseTimerRef = useRef(null)
  const cardBusyRef = useRef(false)   // true while the in-flight request is a card-photo lookup, not a text question
  const chatIdRef = useRef(chatId)   // lets an in-flight request notice a chat switch after its await

  useEffect(() => { chatIdRef.current = chatId }, [chatId])
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, busy])
  useEffect(() => () => recorderRef.current?.stop(), [])   // release the mic if the view unmounts mid-recording
  useEffect(() => () => clearTimeout(undoTimerRef.current), [])

  // Wave on landing in a chat (including the very first mount), then settle to idle.
  useEffect(() => {
    setPose('wave')
    clearTimeout(poseTimerRef.current)
    poseTimerRef.current = setTimeout(() => setPose('idle'), 1600)
    return () => clearTimeout(poseTimerRef.current)
  }, [chatId])

  // Hand-to-chin the moment a text question goes out — or, for a card photo, reach under
  // the desk for the magnifying glass and hold it up while the photo is being classified.
  useEffect(() => {
    if (busy) { clearTimeout(poseTimerRef.current); setPose(cardBusyRef.current ? 'inspect' : 'think') }
  }, [busy])

  // ...and "talking" once it lands, for as long as the user hasn't started typing again —
  // unless the reply itself got flagged (injection redacted / content filtered), in which
  // case he shakes his head "no" instead of chattering away.
  useEffect(() => {
    if (busy) return
    const last = messages[messages.length - 1]
    if (!last || (last.role !== 'bot' && last.role !== 'err' && last.role !== 'card')) return
    const notes = last.data?.security_notes || []
    const flagged = notes.some((n) => n.startsWith('passage [') || n.startsWith('blocked by provider content filter'))
    setPose(flagged ? 'shake' : 'talk')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy])

  // Typing the next question breaks the "talking" pose back to idle — but not the
  // "shake" (flagged reply) pose, which is meant to keep going until the next message.
  useEffect(() => {
    if (!question.trim()) return
    setPose((p) => (p === 'talk' ? 'idle' : p))
  }, [question])

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

  // Card-photo identification — deliberately never touches `messages`/`history` with the
  // actual image: only the placeholder text below and the model's text answer are stored,
  // so nothing image-shaped ever reaches chatStore's localStorage persistence. The file
  // itself lives only in this function's local scope for the duration of the upload.
  async function identifyCardPhoto(file) {
    if (busy) return
    const requestChatId = chatId
    cardBusyRef.current = true
    setError(null)
    setBusyChatIds((s) => new Set(s).add(requestChatId))
    setMessages((m) => [...m, { role: 'user', text: '📷 sent a photo of my card' }])
    try {
      const { answer } = await api.identifyCard(file)
      const botMsg = { role: 'card', text: answer }
      if (chatIdRef.current === requestChatId) {
        setMessages((m) => [...m, botMsg])
        setHistory((h) => [...h, { q: 'sent a photo of my card', a: answer }])
      } else {
        appendToChat(requestChatId, botMsg, { q: 'sent a photo of my card', a: answer })
      }
    } catch (e) {
      if (chatIdRef.current === requestChatId) {
        setMessages((m) => [...m, { role: 'err', text: e.message }])
        setError(e.message)
      } else {
        appendToChat(requestChatId, { role: 'err', text: e.message })
      }
    } finally {
      cardBusyRef.current = false
      setBusyChatIds((s) => { const next = new Set(s); next.delete(requestChatId); return next })
    }
  }

  function handleCardPhoto(e) {
    const file = e.target.files?.[0]
    e.target.value = ''   // never leave the file referenced in the DOM
    if (file) identifyCardPhoto(file)
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
        <DeskPerson pose={pose} />
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
          <div className="msg-row bot">
            <span className="avatar"><span className="status-dot" /></span>
            <div className="msg bot">
              {timeGreeting()}! Sunt Libra AI, asistentul digital Libra Bank. Vă pot ajuta cu informații
              despre conturi, depozite, dobânzi, taxe și alte servicii ale băncii. Cu ce vă pot fi
              de folos astăzi?
            </div>
          </div>
        )}

        {messages.map((m, i) => {
          if (m.role === 'user') return <div className="msg-row user" key={i}><div className="msg user">{m.text}</div></div>
          if (m.role === 'err') return (
            <div className="msg-row bot" key={i}>
              <span className="avatar"><span className="status-dot" /></span>
              <div className="msg err">
                <strong>Request failed:</strong> {m.text}
                {i === messages.length - 1 && (
                  <div style={{ marginTop: '.6rem' }}>
                    <button className="btn btn-outline btn-sm" onClick={regenerate} disabled={busy}>↻ try again</button>
                  </div>
                )}
              </div>
            </div>
          )
          if (m.role === 'card') return (
            <div className="msg-row bot" key={i}>
              <span className="avatar"><span className="status-dot" /></span>
              <div className="msg bot">{m.text}</div>
            </div>
          )
          const d = m.data
          return (
            <div className="msg-row bot" key={i}>
            <span className="avatar"><span className="status-dot" /></span>
            <div className="msg bot">
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
                {d.security_notes?.some((n) => n.startsWith('passage [')) && (
                  <span className="badge crimson" title={d.security_notes.join('; ')}>⚠ injection blocked</span>
                )}
                {d.security_notes?.some((n) => n.startsWith('blocked by provider content filter')) && (
                  <span className="badge crimson" title={d.security_notes.join('; ')}>🛡 content filtered</span>
                )}
                {d.tool_calls?.length > 0 && (
                  <span className="badge gold" title={d.tool_calls.map((t) => `${t.name}(${JSON.stringify(t.arguments)})`).join('; ')}>
                    tools: {d.tool_calls.map((t) => t.name.replaceAll('_', ' ')).join(', ')}
                  </span>
                )}
              </div>
              {d.tool_calls?.length > 0 && (
                <details className="sources">
                  <summary>{d.tool_calls.length} tool call{d.tool_calls.length > 1 ? 's' : ''}</summary>
                  {d.tool_calls.map((t, j) => (
                    <div className="src" key={j}>
                      <span className="score">{t.name}({JSON.stringify(t.arguments)})</span>
                      <div>{JSON.stringify(t.result)}</div>
                    </div>
                  ))}
                </details>
              )}
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
            </div>
          )
        })}
        {busy && (
          <div className="msg-row bot">
            <span className="avatar"><span className="status-dot" /></span>
            <div className="msg bot typing-indicator" title="Thinking…">
              <span /><span /><span />
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <Err error={error} />
      <div className="composer">
        <textarea value={question} placeholder="Ask Libra AI…  (Enter to send, Shift+Enter for a new line)"
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
        <label className="btn btn-outline shrink" title="Send a photo of your card to identify it — the photo itself is never saved"
               style={{ opacity: busy ? .5 : 1, pointerEvents: busy ? 'none' : 'auto' }}>
          📷
          <input type="file" accept="image/*" style={{ display: 'none' }} onChange={handleCardPhoto} disabled={busy} />
        </label>
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
