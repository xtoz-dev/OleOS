import { useEffect, useState, type FormEvent } from 'react'
import { Inbox, MailOpen, PenLine, RefreshCw, Reply, Send, Trash2, X } from 'lucide-react'

type MailUser = { id: string; username: string; displayName: string; avatar: string }
type MailMessage = { id: string; subject: string; body: string; readAt: string | null; createdAt: string; sender: MailUser; recipient: MailUser }
type MailFolder = 'inbox' | 'sent'

async function api<T>(url: string, csrfToken: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, ...(init.headers || {}) } })
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    throw new Error(data?.error || `Anfrage fehlgeschlagen (${response.status}).`)
  }
  return response.status === 204 ? undefined as T : response.json()
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
}

export function MailApp({ csrfToken, userId }: { csrfToken: string; userId: string }) {
  const [folder, setFolder] = useState<MailFolder>('inbox')
  const [messages, setMessages] = useState<MailMessage[]>([])
  const [users, setUsers] = useState<MailUser[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [selected, setSelected] = useState<MailMessage | null>(null)
  const [composing, setComposing] = useState(false)
  const [recipientId, setRecipientId] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)

  const load = async (which: MailFolder = folder) => {
    try {
      const result = await api<{ messages: MailMessage[]; unreadCount: number }>(`/api/mail?folder=${which}`, csrfToken)
      setMessages(result.messages)
      setUnreadCount(result.unreadCount)
      setError('')
    } catch (e) { setError(e instanceof Error ? e.message : 'Postfach konnte nicht geladen werden.') }
  }

  useEffect(() => { void load(folder) }, [folder, csrfToken])
  useEffect(() => {
    let active = true
    api<{ users: MailUser[] }>('/api/social/users', csrfToken).then(result => { if (active) setUsers(result.users) }).catch(e => { if (active) setError(e instanceof Error ? e.message : 'Nutzerliste konnte nicht geladen werden.') })
    return () => { active = false }
  }, [csrfToken])
  useEffect(() => {
    const timer = window.setInterval(() => { void load(folder) }, 30000)
    return () => window.clearInterval(timer)
  }, [csrfToken, folder])

  const selectMessage = async (message: MailMessage) => {
    setSelected(message); setComposing(false); setError(''); setStatus('')
    if (folder === 'inbox' && !message.readAt) {
      setMessages(current => current.map(item => item.id === message.id ? { ...item, readAt: new Date().toISOString() } : item))
      setSelected(current => current?.id === message.id ? { ...current, readAt: new Date().toISOString() } : current)
      setUnreadCount(count => Math.max(0, count - 1))
      try { await api(`/api/mail/${message.id}/read`, csrfToken, { method: 'PATCH' }) }
      catch (e) { setError(e instanceof Error ? e.message : 'Nachricht konnte nicht als gelesen markiert werden.') }
    }
  }

  const startCompose = (to = '', title = '') => {
    setRecipientId(to); setSubject(title); setBody(''); setSelected(null); setComposing(true); setError(''); setStatus('')
  }

  const sendMail = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true); setError(''); setStatus('')
    try {
      const result = await api<{ message: MailMessage }>('/api/mail', csrfToken, { method: 'POST', body: JSON.stringify({ recipientId, subject, body }) })
      setFolder('sent'); setComposing(false); setSelected(result.message); setStatus('Nachricht wurde gesendet.')
      await load('sent')
    } catch (e) { setError(e instanceof Error ? e.message : 'Nachricht konnte nicht gesendet werden.') }
    finally { setBusy(false) }
  }

  const remove = async () => {
    if (!selected || !window.confirm('Diese Nachricht aus deinem Postfach entfernen?')) return
    try {
      await api(`/api/mail/${selected.id}?folder=${folder}`, csrfToken, { method: 'DELETE' })
      setSelected(null); setStatus('Nachricht entfernt.'); await load(folder)
    } catch (e) { setError(e instanceof Error ? e.message : 'Nachricht konnte nicht entfernt werden.') }
  }

  const otherUser = selected ? folder === 'inbox' ? selected.sender : selected.recipient : null
  return <div className="mail-app">
    <aside className="mail-sidebar">
      <button className="mail-compose-button" onClick={() => startCompose()}><PenLine size={15}/> Neue Nachricht</button>
      <button className={`mail-folder ${folder === 'inbox' ? 'active' : ''}`} onClick={() => { setFolder('inbox'); setSelected(null); setComposing(false) }}><Inbox size={16}/> Posteingang {unreadCount > 0 && <b>{unreadCount}</b>}</button>
      <button className={`mail-folder ${folder === 'sent' ? 'active' : ''}`} onClick={() => { setFolder('sent'); setSelected(null); setComposing(false) }}><Send size={15}/> Gesendet</button>
      <div className="mail-sidebar-note">OleOS Mail<br/><small>Nachrichten an andere Nutzer</small></div>
    </aside>
    <section className="mail-main">
      <header className="mail-toolbar"><b>{folder === 'inbox' ? 'Posteingang' : 'Gesendete Nachrichten'}</b><span>{folder === 'inbox' && unreadCount ? `${unreadCount} ungelesen` : `${messages.length} Nachrichten`}</span><button aria-label="Aktualisieren" title="Aktualisieren" onClick={() => void load()}><RefreshCw size={14}/></button></header>
      {error && <div className="mail-error">{error}<button aria-label="Schließen" onClick={() => setError('')}><X size={13}/></button></div>}
      <div className="mail-content">
        <div className="mail-list">
          {messages.map(message => {
            const contact = folder === 'inbox' ? message.sender : message.recipient
            return <button key={message.id} className={`mail-row ${selected?.id === message.id ? 'selected' : ''} ${folder === 'inbox' && !message.readAt ? 'unread' : ''}`} onClick={() => void selectMessage(message)}>
              <img src={contact.avatar} alt=""/><span className="mail-row-info"><b>{contact.displayName}</b><strong>{message.subject}</strong><small>{message.body.replace(/\s+/g, ' ').slice(0, 72)}</small></span><time>{formatDate(message.createdAt)}</time>
            </button>
          })}
          {!messages.length && <div className="mail-empty">{folder === 'inbox' ? 'Dein Posteingang ist noch leer.' : 'Du hast noch keine Nachrichten gesendet.'}</div>}
        </div>
        <article className="mail-detail">
          {composing ? <form className="mail-compose" onSubmit={sendMail}>
            <header><h2>Neue Nachricht</h2><button type="button" aria-label="Schließen" onClick={() => setComposing(false)}><X size={15}/></button></header>
            <label>An<select required value={recipientId} onChange={event => setRecipientId(event.target.value)}><option value="">OleOS-Nutzer auswählen …</option>{users.filter(item => item.id !== userId).map(item => <option key={item.id} value={item.id}>{item.displayName} (@{item.username})</option>)}</select></label>
            <label>Betreff<input required maxLength={120} value={subject} onChange={event => setSubject(event.target.value)} placeholder="Betreff"/></label>
            <textarea required maxLength={10000} value={body} onChange={event => setBody(event.target.value)} placeholder="Deine Nachricht …"/>
            <footer><small>{body.length}/10.000 Zeichen</small><button className="mail-send-button" disabled={busy || !users.length}><Send size={14}/>{busy ? 'Wird gesendet …' : 'Senden'}</button></footer>
          </form> : selected ? <>
            <header className="mail-message-heading"><h2>{selected.subject}</h2><button title="Aus Postfach entfernen" aria-label="Löschen" onClick={() => void remove()}><Trash2 size={15}/></button></header>
            <div className="mail-message-meta"><img src={otherUser?.avatar} alt=""/><div><b>{folder === 'inbox' ? selected.sender.displayName : `An: ${selected.recipient.displayName}`}</b><small>{folder === 'inbox' ? `@${selected.sender.username}` : `@${selected.recipient.username}`}</small></div><time>{formatDate(selected.createdAt)}</time></div>
            <div className="mail-message-body">{selected.body}</div>
            <footer className="mail-detail-footer"><button onClick={() => startCompose(otherUser?.id || '', selected.subject.toLowerCase().startsWith('re:') ? selected.subject : `Re: ${selected.subject}`)}><Reply size={14}/> Antworten</button><button onClick={() => void remove()}><Trash2 size={14}/> Entfernen</button></footer>
          </> : <div className="mail-welcome"><MailOpen size={35}/><b>{status || 'OleOS Mail'}</b><span>Wähle eine Nachricht aus oder schreibe jemandem.</span>{status && <button onClick={() => setStatus('')}>Schließen</button>}</div>}
        </article>
      </div>
    </section>
  </div>
}
