// Chat persistence — everything lives in the browser's localStorage as plain
// JSON, one object per chat. Export/import turn a chat into a real .json file
// on disk for anyone who wants an actual artifact instead of just "local".
const STORAGE_KEY = 'libra-assist:chats'
const TITLE_MAX = 42

function readAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function writeAll(all) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
}

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/** Chats sorted newest-first — what the log panel renders. */
export function listChats() {
  return Object.values(readAll()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function makeChat() {
  const now = new Date().toISOString()
  return { id: newId(), title: 'New chat', createdAt: now, updatedAt: now, messages: [], history: [] }
}

export function saveChat(chat) {
  const all = readAll()
  all[chat.id] = chat
  writeAll(all)
}

export function deleteChat(id) {
  const all = readAll()
  delete all[id]
  writeAll(all)
}

/** Audio blob URLs die with the page — drop them before persisting, keep a marker instead. */
export function stripAudioForSave(m) {
  if (m.role !== 'bot' || !m.audio) return m
  const { audio, ...rest } = m
  return { ...rest, hadAudio: true }
}

/** Once a chat has a real first question, name it after that instead of "New chat". */
export function deriveTitle(currentTitle, messages) {
  if (currentTitle && currentTitle !== 'New chat') return currentTitle
  const firstUser = messages.find((m) => m.role === 'user')
  if (!firstUser) return 'New chat'
  const text = firstUser.text.trim()
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}…` : text
}

export function exportChat(chat) {
  const blob = new Blob([JSON.stringify(chat, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${(chat.title || 'chat').replace(/[^\w.-]+/g, '_')}-${chat.id.slice(0, 8)}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** Parses an uploaded .json export. Throws with a message fit to show the user. */
export function parseImportedChat(rawText, existingIds) {
  let data
  try {
    data = JSON.parse(rawText)
  } catch {
    throw new Error('not valid JSON')
  }
  if (!data || !Array.isArray(data.messages)) throw new Error('missing a "messages" array — not a chat export')

  const now = new Date().toISOString()
  return {
    id: data.id && !existingIds.has(data.id) ? data.id : newId(),
    title: data.title || 'Imported chat',
    createdAt: data.createdAt || now,
    updatedAt: now,
    messages: data.messages,
    history: Array.isArray(data.history) ? data.history : [],
  }
}
