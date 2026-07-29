import { useEffect } from 'react'
import { Head, RunsOnBadge } from '../components'

// Everything that shapes how Chat answers, lifted out of the Chat view so it has
// its own tab. Voice replies stays on the Chat composer instead — that's a toggle
// you flip mid-conversation, not a setting you configure ahead of time.
export default function Settings({
  agents, hostedOnly = [], foundry,
  agent, setAgent, useRag, setUseRag, useHistory, setUseHistory,
  mode, setMode, topK, setTopK, minScore, setMinScore, sourceFilter, setSourceFilter,
}) {
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
    <>
      <Head title="Settings">
        Which persona answers, whether it's grounded in retrieved documents, and where the
        agent loop runs. Everything here carries over to Chat immediately.
      </Head>

      <div className="card">
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
      </div>
    </>
  )
}
