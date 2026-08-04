import { useEffect, useState } from 'react'
import { api } from '../api'
import { Err, Head, Spinner } from '../components'

export default function Documents() {
  const [docs, setDocs] = useState(null)
  const [cards, setCards] = useState(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState(null)
  const [copiedSource, setCopiedSource] = useState(null)

  useEffect(() => {
    setBusy(true)
    Promise.all([api.documents(), api.referenceCards().catch(() => ({ cards: [] }))])
      .then(([d, c]) => { setDocs(d.documents); setCards(c.cards) })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false))
  }, [])

  async function copySource(source, e) {
    e.preventDefault(); e.stopPropagation()   // don't toggle the <details> open/closed
    try {
      await navigator.clipboard.writeText(source)
      setCopiedSource(source)
      setTimeout(() => setCopiedSource((s) => (s === source ? null : s)), 1500)
    } catch { /* clipboard permission denied — non-critical */ }
  }

  return (
    <>
      <Head title="Documents">
        The corpus on disk — the same source files <code>scripts/load_corpus.py</code> ingests
        into Qdrant. Read-only: edit the .md files and re-run the ingest script to update what
        the agent is grounded on. The tagged value under each title is what Settings →
        source filter expects, to restrict retrieval to just that one document.
      </Head>

      {busy && <Spinner label="loading documents" />}
      <Err error={error} />

      {docs && (
        <div className="card">
          <p className="muted" style={{ marginTop: 0 }}>{docs.length} document{docs.length === 1 ? '' : 's'}</p>
          {docs.map((doc) => (
            <details className="sources" key={doc.source} style={{ marginBottom: '.7rem' }}>
              <summary>
                <strong>{doc.title}</strong>
                <span className="badge muted mono" style={{ marginLeft: '.5rem' }}
                      title="Paste this into Settings → source filter to restrict retrieval to this document">
                  {doc.source}
                </span>
                <button className="icon-btn" title="Copy source filter value"
                        onClick={(e) => copySource(doc.source, e)}>
                  {copiedSource === doc.source ? '✓' : '⧉'}
                </button>
                <span className="faint"> · {doc.chars} chars</span>
              </summary>
              <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap', margin: '.6rem 0' }}>
                {doc.metadata.product && <span className="badge muted">{doc.metadata.product}</span>}
                {doc.metadata.audience && <span className="badge muted">{doc.metadata.audience}</span>}
                {doc.metadata.effective && <span className="badge muted">effective {doc.metadata.effective}</span>}
                {doc.metadata.version != null && <span className="badge muted">v{doc.metadata.version}</span>}
              </div>
              <pre className="out">{doc.text}</pre>
            </details>
          ))}
        </div>
      )}

      {cards && cards.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Reference card photos</h3>
          <p className="muted" style={{ marginTop: 0 }}>
            What <code>/tools/identify-card</code> compares a customer's photo against — see
            the 📷 button in Chat. Read-only here; add or replace photos directly in
            <code> app/services/reference_cards/</code> on the backend.
          </p>
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
            {cards.map((c) => (
              <div key={c.filename} style={{ width: 160 }}>
                <img src={c.url} alt={c.label}
                     style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)' }} />
                <p className="faint" style={{ margin: '.4rem 0 0', textAlign: 'center' }}>{c.label}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
