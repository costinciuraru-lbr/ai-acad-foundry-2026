import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { Err, RunsOnBadge } from '../components'

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

export default function Chat({ agents, hostedOnly = [], foundry }) {
  const [messages, setMessages] = useState([])
  const [history, setHistory] = useState([])          // [{q, a}] — for multi-turn context
  const [question, setQuestion] = useState('')
  const [agent, setAgent] = useState('default')
  const [useRag, setUseRag] = useState(true)
  const [useHistory, setUseHistory] = useState(true)
  const [mode, setMode] = useState('local')
  const [topK, setTopK] = useState(3)
  const [minScore, setMinScore] = useState('')
  const [sourceFilter, setSourceFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const endRef = useRef(null)

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, busy])

  async function send() {
    const text = question.trim()
    if (!text || busy) return
    setQuestion(''); setError(null); setBusy(true)
    setMessages((m) => [...m, { role: 'user', text }])
    try {
      const sent = useHistory ? withHistory(history, text) : text
      const data = await api.ask({
        question: sent, use_rag: useRag, top_k: Number(topK), agent, agent_mode: mode,
        min_score: minScore !== '' ? Number(minScore) : undefined,
        filters: sourceFilter.trim() ? { source: sourceFilter.trim() } : undefined,
      })
      setMessages((m) => [...m, { role: 'bot', data }])
      setHistory((h) => [...h, { q: text, a: data.answer }])
    } catch (e) {
      setMessages((m) => [...m, { role: 'err', text: e.message }])
      setError(e.message)
    } finally { setBusy(false) }
  }

  const all = [...agents, ...hostedOnly]
  const current = all.find((a) => a.name === agent)

  // Where this agent CAN run decides which lanes are offered.
  const hostedKnown = foundry?.available
  const isHosted = current?.runs_on === 'both' || current?.runs_on === 'foundry'
  const localImpossible = current?.runs_on === 'foundry'      // no JSON file to run here
  const foundryBlocked = hostedKnown && !isHosted             // definitely not deployed

  // Keep the mode legal whenever the selected agent changes.
  useEffect(() => {
    if (localImpossible && mode !== 'foundry') setMode('foundry')
    else if (foundryBlocked && mode === 'foundry') setMode('local')
  }, [agent, localImpossible, foundryBlocked])   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="chat-wrap">
      <div className="chat-bar">
        <select value={agent} onChange={(e) => setAgent(e.target.value)} title="Which persona answers">
          {agents.map((a) => <option key={a.name} value={a.name}>{a.display_name}</option>)}
          {hostedOnly.length > 0 && (
            <optgroup label="hosted in Foundry only">
              {hostedOnly.map((a) => <option key={a.name} value={a.name}>{a.display_name}</option>)}
            </optgroup>
          )}
        </select>
        {current && <RunsOnBadge runsOn={current.runs_on} reason={foundry?.reason} />}
        <label className="check" style={{ margin: 0 }}>
          <input type="checkbox" checked={useRag} onChange={(e) => setUseRag(e.target.checked)} />
          use RAG
        </label>
        <select value={mode} onChange={(e) => setMode(e.target.value)} style={{ minWidth: '9rem' }}
                title="Where the loop executes">
          <option value="local" disabled={localImpossible}
                  title={localImpossible ? 'This agent has no local JSON file' : ''}>
            local agent
          </option>
          <option value="foundry" disabled={foundryBlocked}
                  title={foundryBlocked ? 'Not deployed to Foundry — deploy it from the Agents view' : ''}>
            Foundry agent{foundryBlocked ? ' — not deployed' : ''}
          </option>
        </select>
        <input type="number" min="1" max="10" value={topK} onChange={(e) => setTopK(e.target.value)}
               style={{ width: '4.5rem', flex: '0 0 auto' }} title="Passages to retrieve" />
        <label className="check" style={{ margin: 0 }} title="Fold the last few turns into the question so follow-ups make sense">
          <input type="checkbox" checked={useHistory} onChange={(e) => setUseHistory(e.target.checked)} />
          history
        </label>
        <button className="btn btn-outline btn-sm" onClick={() => { setMessages([]); setHistory([]) }}>clear</button>
        {current && <span className="badge muted" title={current.description}>temp {current.temperature ?? '—'}</span>}
      </div>
      <div className="chat-bar" style={{ marginTop: '.4rem' }}>
        <div style={{ maxWidth: '9rem' }}>
          <input type="number" step="0.05" min="0" max="1" placeholder="min score: off" value={minScore}
                 onChange={(e) => setMinScore(e.target.value)} title="Drop retrieved passages below this cosine similarity" />
        </div>
        <input type="text" value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}
               placeholder="source filter, e.g. notice-period-policy-v2" style={{ minWidth: '16rem' }}
               title="Exact match on the source field" />
      </div>

      <div className="msgs">
        {messages.length === 0 && (
          <div className="card" style={{ alignSelf: 'center', maxWidth: '46rem', textAlign: 'center' }}>
            <h3>Libra Assist</h3>
            <p className="muted" style={{ margin: 0 }}>
              Ask a question about the documents you have ingested. Switch the persona to change how
              it answers, or turn RAG off to see the model answer without grounding.
            </p>
          </div>
        )}

        {messages.map((m, i) => {
          if (m.role === 'user') return <div className="msg user" key={i}>{m.text}</div>
          if (m.role === 'err') return <div className="msg err" key={i}><strong>Request failed:</strong> {m.text}</div>
          const d = m.data
          return (
            <div className="msg bot" key={i}>
              {d.answer}
              <div className="msg-meta">
                <span className="badge">{d.agent?.display_name || 'agent'}</span>
                <span className={`badge ${d.augmented ? 'gold' : 'muted'}`}>{d.augmented ? 'grounded' : 'no retrieval'}</span>
                <span className="badge muted">{d.agent?.mode}</span>
                <span className="badge muted">{d.model}</span>
                {d.usage && <span className="badge muted">{d.usage.prompt_tokens}↑ {d.usage.completion_tokens}↓ tokens</span>}
                {d.dropped_below_threshold > 0 &&
                  <span className="badge muted">{d.dropped_below_threshold} dropped below threshold</span>}
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
        {busy && <div className="msg bot"><span className="spin" /> thinking…</div>}
        <div ref={endRef} />
      </div>

      <Err error={error} />
      <div className="composer">
        <textarea value={question} placeholder="Ask Libra Assist…  (Enter to send, Shift+Enter for a new line)"
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
        <button className="btn btn-primary" onClick={send} disabled={busy || !question.trim()}>Send</button>
      </div>
    </div>
  )
}
