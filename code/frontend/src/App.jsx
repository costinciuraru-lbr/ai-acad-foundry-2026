import { useCallback, useEffect, useState } from 'react'
import { api } from './api'
import Agents from './views/Agents'
import Chat from './views/Chat'
import Documents from './views/Documents'
import Knowledge from './views/Knowledge'
import Search from './views/Search'
import Settings from './views/Settings'
import Status from './views/Status'
import Tools from './views/Tools'

const VIEWS = [
  { id: 'chat', label: 'Chat', group: 'Assistant' },
  { id: 'settings', label: 'Settings', group: 'Assistant' },
  { id: 'documents', label: 'Documents', group: 'Pipeline' },
  { id: 'knowledge', label: 'Knowledge', group: 'Pipeline' },
  { id: 'search', label: 'Retrieval', group: 'Pipeline' },
  { id: 'agents', label: 'Agents', group: 'Platform' },
  { id: 'tools', label: 'Tools', group: 'Platform' },
  { id: 'status', label: 'Status', group: 'Platform' },
]

const ADMIN_GROUPS = ['Pipeline', 'Platform']

export default function App() {
  const [view, setView] = useState('chat')
  const [agents, setAgents] = useState([])
  const [hostedOnly, setHostedOnly] = useState([])
  const [foundry, setFoundry] = useState(null)
  const [health, setHealth] = useState(null)
  const [azure, setAzure] = useState(null)
  const [theme, setTheme] = useState('light')
  const [adminOpen, setAdminOpen] = useState(false)
  const [sideOpen, setSideOpen] = useState(false)
  // Reported up from Chat (token totals + active persona) so the page-title row can
  // show them without owning Chat's message state itself.
  const [chatStatus, setChatStatus] = useState(null)

  // Chat's answering settings — lifted up here so both the Chat and Settings
  // views can read/change them.
  const [agent, setAgent] = useState('banccherul')
  const [useRag, setUseRag] = useState(true)
  const [useHistory, setUseHistory] = useState(true)
  const [mode, setMode] = useState('local')
  const [topK, setTopK] = useState(4)
  const [minScore, setMinScore] = useState('0.5')
  const [sourceFilter, setSourceFilter] = useState('')
  const [ttsVoice, setTtsVoice] = useState('')   // '' = server default (.env AZURE_SPEECH_VOICE)

  const loadAgents = useCallback(() => {
    api.agents()
      .then((d) => { setAgents(d.personas || []); setHostedOnly(d.hosted_only || []); setFoundry(d.foundry) })
      .catch(() => { setAgents([]); setHostedOnly([]); setFoundry(null) })
  }, [])
  const loadHealth = useCallback(() => {
    api.health().then(setHealth).catch(() => setHealth(null))
  }, [])
  const loadAzure = useCallback(() => {
    api.azure().then(setAzure).catch(() => setAzure(null))
  }, [])

  useEffect(() => { loadAgents(); loadHealth(); loadAzure() }, [loadAgents, loadHealth, loadAzure])
  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])

  const groups = [...new Set(VIEWS.map((v) => v.group))]
  const topGroups = groups.filter((g) => !ADMIN_GROUPS.includes(g))
  const adminGroups = groups.filter((g) => ADMIN_GROUPS.includes(g))
  const online = health?.status === 'ok'

  return (
    <div className="app">
      <div className="side-zone" onMouseEnter={() => setSideOpen(true)} onMouseLeave={() => setSideOpen(false)}>
      <aside className={`side ${sideOpen ? 'open' : ''}`}>
        <p className="brand">Libra AI<small>console</small></p>
        {topGroups.map((g) => (
          <div key={g}>
            <div className="nav-group">{g}</div>
            {VIEWS.filter((v) => v.group === g).map((v) => (
              <button key={v.id} className={`nav-item ${view === v.id ? 'active' : ''}`} onClick={() => setView(v.id)}>
                <span className="dot" />{v.label}
              </button>
            ))}
          </div>
        ))}

        <div>
          <button className="nav-item nav-toggle" onClick={() => setAdminOpen((o) => !o)}>
            <span className="dot" />Admin
            <span style={{ marginLeft: 'auto' }}>{adminOpen ? '▾' : '▸'}</span>
          </button>
          {adminOpen && adminGroups.map((g) => (
            <div key={g}>
              <div className="nav-group nav-group-sub">{g}</div>
              {VIEWS.filter((v) => v.group === g).map((v) => (
                <button key={v.id} className={`nav-item nav-item-sub ${view === v.id ? 'active' : ''}`}
                        onClick={() => setView(v.id)}>
                  <span className="dot" />{v.label}
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="side-foot">
          <div style={{ display: 'flex', alignItems: 'center', gap: '.4rem', marginBottom: '.4rem' }}>
            <span className="dot" style={{ width: 7, height: 7, borderRadius: '50%',
              background: online ? 'var(--accent)' : 'var(--text-faint)', display: 'inline-block' }} />
            {online ? `${health.llm.provider} · ${health.llm.model}` : 'backend offline'}
          </div>
          {azure?.configured && (
            <div style={{ marginBottom: '.5rem' }} title={azure.auth === 'identity'
              ? 'Signed in with Microsoft Entra — the Agent Service and control plane are available'
              : 'Key authentication — the Agent Service and control plane cannot be queried'}>
              <span className={`badge ${azure.auth === 'identity' ? '' : 'gold'}`}>
                {azure.auth === 'identity' ? 'Entra identity' : 'key auth'}
              </span>
            </div>
          )}
          <button className="btn btn-outline btn-sm" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            ◐ {theme === 'dark' ? 'light' : 'dark'}
          </button>
        </div>
      </aside>
      </div>

      <main className={`main${view === 'chat' ? ' main-chat' : ''}`}>
        <div className="page-title-bar">
          <div className="page-title">Libra AI</div>
          {view === 'chat' && chatStatus && (
            <div className="page-title-status">
              <span className="badge muted" title="Total prompt/completion tokens billed for this conversation so far">
                {chatStatus.tokensIn}↑ in · {chatStatus.tokensOut}↓ out
              </span>
              {chatStatus.personaLabel && (
                <span className="badge muted" title="Change persona, RAG, mode etc. in Settings">
                  {chatStatus.personaLabel}
                </span>
              )}
            </div>
          )}
        </div>
        {/* Always mounted, just hidden when not active — switching tabs must not unmount
            Chat mid-request, or its in-flight /ask response has nowhere to land. */}
        <div style={{ display: view === 'chat' ? 'contents' : 'none' }}>
          <Chat agents={agents} hostedOnly={hostedOnly} foundry={foundry}
                agent={agent} useRag={useRag} useHistory={useHistory} mode={mode}
                topK={topK} minScore={minScore} sourceFilter={sourceFilter} ttsVoice={ttsVoice}
                onStatus={setChatStatus} />
        </div>
        {view === 'settings' && (
          <Settings agents={agents} hostedOnly={hostedOnly} foundry={foundry}
                    agent={agent} setAgent={setAgent} useRag={useRag} setUseRag={setUseRag}
                    useHistory={useHistory} setUseHistory={setUseHistory} mode={mode} setMode={setMode}
                    topK={topK} setTopK={setTopK} minScore={minScore} setMinScore={setMinScore}
                    sourceFilter={sourceFilter} setSourceFilter={setSourceFilter}
                    ttsVoice={ttsVoice} setTtsVoice={setTtsVoice} />
        )}
        {view === 'documents' && <Documents />}
        {view === 'knowledge' && <Knowledge />}
        {view === 'search' && <Search />}
        {view === 'agents' && <Agents agents={agents} hostedOnly={hostedOnly} foundry={foundry}
                                      reload={loadAgents} azure={azure} />}
        {view === 'tools' && <Tools />}
        {view === 'status' && <Status health={health} reload={loadHealth}
                                      azure={azure} reloadAzure={loadAzure} />}
      </main>
    </div>
  )
}
