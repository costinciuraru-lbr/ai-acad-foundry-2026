import { useEffect, useState } from 'react'
import { api } from '../api'
import { ChunkList, Err, Head, Hits, RawJson, Spinner } from '../components'

const SAMPLE = `Libra Bank issues debit and credit cards to retail customers. A card is blocked automatically after three failed PIN attempts, after the fraud engine flags a suspicious transaction, or at the customer's own request in the mobile application. A blocked card is unblocked in the branch after identity verification, or through the call centre using the phone banking password.

Mortgage loans require a down payment of at least fifteen percent for a first home. Early repayment is free of charge during the variable-rate period; during the fixed-rate period an early repayment fee of one percent applies.

Term deposits can be opened in RON, EUR or USD, with maturities from one month to two years. Breaking a deposit before maturity forfeits the accrued interest.`

export default function Knowledge() {
  const [text, setText] = useState(SAMPLE)
  const [strategy, setStrategy] = useState('heading')
  const [size, setSize] = useState(400)
  const [overlap, setOverlap] = useState(80)
  const [sentences, setSentences] = useState(3)
  const [threshold, setThreshold] = useState(0.75)
  const [source, setSource] = useState('console')
  const [title, setTitle] = useState('')
  const [product, setProduct] = useState('')
  const [audience, setAudience] = useState('')
  const [effective, setEffective] = useState('')
  const [version, setVersion] = useState('')
  const [preview, setPreview] = useState(null)
  const [ingested, setIngested] = useState(null)
  const [collection, setCollection] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState(null)

  const refresh = () => api.collection().then(setCollection).catch(() => setCollection(null))
  useEffect(() => { refresh() }, [])

  const metadata = () => {
    const m = { title, product, audience, effective, version }
    return Object.fromEntries(Object.entries(m).filter(([, v]) => v))
  }

  const payload = () => ({
    text, strategy,
    chunk_size: Number(size), chunk_overlap: Number(overlap),
    sentences_per_chunk: Number(sentences), semantic_threshold: Number(threshold),
  })

  async function run(kind) {
    setBusy(kind); setError(null)
    try {
      if (kind === 'chunk') { setPreview(await api.chunk(payload())); setIngested(null) }
      else {
        const r = await api.ingest({ ...payload(), source, metadata: metadata() })
        setIngested(r); setPreview(null); refresh()
      }
    } catch (e) { setError(e.message) } finally { setBusy('') }
  }

  async function reset() {
    setBusy('reset'); setError(null)
    try { await api.resetCollection(); setIngested(null); setPreview(null); refresh() }
    catch (e) { setError(e.message) } finally { setBusy('') }
  }

  return (
    <>
      <Head title="Knowledge">
        Split a document into chunks and store them as vectors. Chunking is the highest-leverage
        decision in a RAG pipeline — compare the strategies on the same text and watch the
        boundaries move.
      </Head>

      <div className="card">
        <label>Document</label>
        <textarea value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: 160 }} />

        <div className="row" style={{ marginTop: '.8rem' }}>
          <div>
            <label>Strategy</label>
            <select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
              <option value="static">static — fixed windows</option>
              <option value="sentence">sentence — N per chunk</option>
              <option value="dynamic">dynamic — structure aware</option>
              <option value="semantic">semantic — meaning aware</option>
              <option value="heading">heading — Markdown-structure aware</option>
            </select>
          </div>
          {(strategy === 'static' || strategy === 'dynamic' || strategy === 'heading') && (
            <div><label>Chunk size</label><input type="number" value={size} onChange={(e) => setSize(e.target.value)} /></div>
          )}
          {(strategy === 'static' || strategy === 'dynamic') && (
            <div><label>Overlap</label><input type="number" value={overlap} onChange={(e) => setOverlap(e.target.value)} /></div>
          )}
          {strategy === 'sentence' && (
            <div><label>Sentences / chunk</label><input type="number" value={sentences} onChange={(e) => setSentences(e.target.value)} /></div>
          )}
          {strategy === 'semantic' && (
            <div><label>Similarity threshold</label><input type="number" step="0.05" min="0.05" max="1" value={threshold} onChange={(e) => setThreshold(e.target.value)} /></div>
          )}
        </div>
        {strategy === 'heading' && (
          <p className="faint" style={{ marginTop: '.4rem' }}>
            Splits on Markdown '#'/'##' headings, never cuts a table row or list item across two
            chunks, and prefixes each chunk with "title — heading" using the metadata below.
          </p>
        )}

        <div className="row" style={{ marginTop: '.9rem' }}>
          <div><label>source</label><input type="text" value={source} onChange={(e) => setSource(e.target.value)} placeholder="e.g. cards-policy" /></div>
          <div><label>title</label><input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Document title" /></div>
          <div><label>product</label><input type="text" value={product} onChange={(e) => setProduct(e.target.value)} placeholder="e.g. deposits" /></div>
          <div><label>audience</label><input type="text" value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="e.g. retail" /></div>
          <div><label>effective</label><input type="text" value={effective} onChange={(e) => setEffective(e.target.value)} placeholder="YYYY-MM-DD" /></div>
          <div><label>version</label><input type="text" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1" /></div>
        </div>
        <p className="faint" style={{ marginTop: '.3rem' }}>
          <code>source</code> keys re-ingestion: posting the same source again replaces its old
          chunks instead of duplicating them. The rest is stored as payload metadata and can be
          used to filter search results (see the Retrieval view).
        </p>

        <div className="row" style={{ marginTop: '.9rem' }}>
          <button className="btn btn-outline shrink" onClick={() => run('chunk')} disabled={!!busy}>Preview chunks</button>
          <button className="btn btn-primary shrink" onClick={() => run('ingest')} disabled={!!busy}>Chunk + embed + store</button>
          <div className="shrink" style={{ alignSelf: 'center' }}>{busy && <Spinner label={busy} />}</div>
        </div>
        <Err error={error} />
      </div>

      {preview && (
        <div className="card">
          <h3>{preview.count} chunks · strategy “{preview.strategy}” <span className="faint">(nothing stored)</span></h3>
          <ChunkList chunks={preview.chunks} />
          <RawJson data={preview} />
        </div>
      )}

      {ingested && (
        <div className="card">
          <h3>
            Stored {ingested.count} chunks
            {ingested.replaced > 0 && <span className="faint"> · replaced {ingested.replaced} stale chunk{ingested.replaced > 1 ? 's' : ''} from a previous ingest of this source</span>}
          </h3>
          <p className="muted" style={{ marginTop: 0 }}>
            Embedded with <code>{ingested.embedding_model.model}</code> into{' '}
            <strong>{ingested.vector_dimension}</strong> dimensions. First eight numbers of chunk 0:
          </p>
          <pre className="out">{JSON.stringify(ingested.embedding_preview)}</pre>
          <ChunkList chunks={ingested.chunks} />
          <RawJson data={ingested} />
        </div>
      )}

      <div className="card">
        <h3>Collection</h3>
        {collection ? (
          <div className="row">
            <div><label>name</label><div className="mono">{collection.name}</div></div>
            <div><label>points</label><div className="mono">{collection.points_count}</div></div>
            <div><label>dimensions</label><div className="mono">{collection.vector_dimension ?? '—'}</div></div>
            <div><label>distance</label><div className="mono">{collection.distance ?? '—'}</div></div>
            <button className="btn btn-outline shrink" onClick={reset} disabled={!!busy}>Reset collection</button>
          </div>
        ) : <p className="faint">Vector store unreachable — is Qdrant running?</p>}
      </div>
    </>
  )
}
