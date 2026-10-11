import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { io, type Socket } from 'socket.io-client'
import { Bell, MessageCircle, Plus, Send, Shield, Share2, Users, X } from 'lucide-react'
import type { Profile } from './programs'

type ApiOptions = { csrfToken: string }
type User = { id: string; displayName: string; username: string; avatar: string; isAdmin?: boolean }
type Room = { id: string; name: string }
type Message = { id: string; senderId: string; senderName: string; content: string; createdAt: string; deletedAt?: string | null; recipientId?: string }
type Share = { id: string; file: { id: string; name: string; kind: 'text' | 'image'; content: string }; owner: User; createdAt: string }
type SentShare = { id: string; file: { id: string; name: string; kind: string; available: boolean } | null; recipient: User | null; createdAt: string }
type PresenceUser = User & { status: 'online' | 'away' }

function trackActivity(connection: Socket) {
  let lastSent = 0
  const markActive = () => {
    if (Date.now() - lastSent < 15000) return
    lastSent = Date.now(); connection.emit('presence:active')
  }
  connection.on('connect', markActive)
  window.addEventListener('pointerdown', markActive)
  window.addEventListener('keydown', markActive)
  window.addEventListener('touchstart', markActive)
  return () => {
    connection.off('connect', markActive)
    window.removeEventListener('pointerdown', markActive)
    window.removeEventListener('keydown', markActive)
    window.removeEventListener('touchstart', markActive)
  }
}

async function request<T>(url: string, csrfToken: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, ...(init.headers || {}) } })
  if (!response.ok) { const body = await response.json().catch(() => null); throw new Error(body?.error || `Anfrage fehlgeschlagen (${response.status}).`) }
  return response.status === 204 ? undefined as T : response.json()
}

export function OleChat({ csrfToken, user, play }: ApiOptions & { user: Profile; play: (kind: 'notify') => void }) {
  const [socket, setSocket] = useState<Socket | null>(null)
  const [rooms, setRooms] = useState<Room[]>([])
  const [online, setOnline] = useState<PresenceUser[]>([])
  const [contacts, setContacts] = useState<User[]>([])
  const [activeRoom, setActiveRoom] = useState('')
  const [activeUser, setActiveUser] = useState<User | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const playRef = useRef(play)
  useEffect(() => { playRef.current = play }, [play])

  useEffect(() => {
    const connection = io({ transports: ['websocket', 'polling'] })
    const stopTracking = trackActivity(connection)
    setSocket(connection)
    connection.on('presence:update', setOnline)
    connection.on('connect_error', issue => setError(issue.message || 'Verbindung zu OleChat fehlgeschlagen.'))
    connection.on('chat:message', message => setMessages(current => current.some(item => item.id === message.id) ? current : [...current, message]))
    connection.on('chat:dm', message => {
      setMessages(current => current.some(item => item.id === message.id) ? current : [...current, message])
      if (message.senderId !== user.id) playRef.current('notify')
    })
    connection.on('chat:deleted', ({ id }) => setMessages(current => current.map(message => message.id === id ? { ...message, content: '[Nachricht von der Moderation entfernt]', deletedAt: new Date().toISOString() } : message)))
    connection.on('share:new', ({ name }) => { setError(`Neue Dateifreigabe erhalten: ${name}`); playRef.current('notify') })
    connection.emit('presence:get', setOnline)
    Promise.all([request<{ rooms: Room[] }>('/api/social/rooms', csrfToken), request<{ users: User[] }>('/api/social/users', csrfToken)])
      .then(([roomData, userData]) => { setRooms(roomData.rooms); setContacts(userData.users); if (roomData.rooms[0]) setActiveRoom(current => current || roomData.rooms[0].id) })
      .catch(issue => setError(issue instanceof Error ? issue.message : 'OleChat konnte nicht geladen werden.'))
    return () => { stopTracking(); connection.disconnect() }
  }, [csrfToken, user.id])

  useEffect(() => {
    if (!socket || !activeRoom || activeUser) return
    socket.emit('chat:join', { roomId: activeRoom, csrfToken }, (result: { messages?: Message[]; error?: string }) => {
      if (result.error) setError(result.error); else setMessages(result.messages || [])
    })
  }, [socket, activeRoom, activeUser, csrfToken])
  useEffect(() => {
    if (!socket || !activeUser) return
    socket.emit('chat:history-dm', { userId: activeUser.id, csrfToken }, (result: { messages?: Message[]; error?: string }) => {
      if (result.error) setError(result.error); else setMessages(result.messages || [])
    })
  }, [socket, activeUser, csrfToken])
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }) }, [messages])

  const shownMessages = useMemo(() => activeUser ? messages.filter(message => (message.senderId === activeUser.id && message.recipientId === user.id) || (message.senderId === user.id && message.recipientId === activeUser.id)) : messages, [messages, activeUser, user.id])
  const selectRoom = (room: Room) => { setActiveUser(null); setMessages([]); setError(''); setActiveRoom(room.id) }
  const selectUser = (contact: User) => { setActiveRoom(''); setActiveUser(contact); setMessages([]); setError('') }
  const send = (event: FormEvent) => {
    event.preventDefault()
    if (!socket || !draft.trim()) return
    const content = draft.trim(); setDraft('')
    socket.emit(activeUser ? 'chat:send-dm' : 'chat:send-room', activeUser ? { userId: activeUser.id, content, csrfToken } : { roomId: activeRoom, content, csrfToken }, (result: { error?: string }) => { if (result.error) { setError(result.error); setDraft(content) } })
  }
  const createRoom = async () => {
    const name = window.prompt('Name des neuen Chatraums (2–32 Zeichen):')
    if (!name?.trim()) return
    try { const result = await request<{ room: Room }>('/api/social/rooms', csrfToken, { method: 'POST', body: JSON.stringify({ name }) }); setRooms(list => [...list, result.room]); selectRoom(result.room) }
    catch (issue) { setError(issue instanceof Error ? issue.message : 'Raum konnte nicht erstellt werden.') }
  }
  const deleteMessage = async (message: Message) => {
    try { await request(`/api/admin/messages/${message.id}`, csrfToken, { method: 'DELETE' }) }
    catch (issue) { setError(issue instanceof Error ? issue.message : 'Moderation fehlgeschlagen.') }
  }

  return <div className="social-chat">
    <aside className="social-sidebar"><div className="social-side-title"><MessageCircle size={15}/> OleChat</div><div className="social-subtitle">RÄUME <button title="Raum erstellen" onClick={() => void createRoom()}><Plus size={14}/></button></div>{rooms.map(room => <button key={room.id} className={`social-nav ${!activeUser && activeRoom === room.id ? 'active' : ''}`} onClick={() => selectRoom(room)}># {room.name}</button>)}<div className="social-subtitle">NACHRICHTEN</div>{contacts.map(contact => <button key={contact.id} className={`social-nav contact-nav ${activeUser?.id === contact.id ? 'active' : ''}`} onClick={() => selectUser(contact)}><img src={contact.avatar} alt=""/>{contact.displayName}<span className={online.some(item => item.id === contact.id) ? 'online-dot' : 'offline-dot'}/></button>)}</aside>
    <section className="social-conversation"><header><div><b>{activeUser ? activeUser.displayName : `# ${rooms.find(room => room.id === activeRoom)?.name || 'OleChat'}`}</b><small>{activeUser ? (online.some(item => item.id === activeUser.id) ? 'Online' : 'Direktnachricht') : `${online.length + 1} online`}</small></div><Users size={17}/></header>
      {error && <div className="social-error">{error}<button onClick={() => setError('')} aria-label="Schließen"><X size={13}/></button></div>}
      <div className="social-messages">{shownMessages.map(message => <article className={`social-message ${message.senderId === user.id ? 'mine' : ''}`} key={message.id}><img src={message.senderId === user.id ? user.avatar : activeUser?.avatar || online.find(item => item.id === message.senderId)?.avatar || ''} alt=""/><div className="social-message-main"><div className="social-message-meta"><b>{message.senderId === user.id ? 'Du' : message.senderName}</b><time>{new Date(message.createdAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</time>{user.isAdmin && <button title="Nachricht moderieren" onClick={() => void deleteMessage(message)}><Shield size={12}/></button>}</div><p>{message.content}</p></div></article>)}{!shownMessages.length && <div className="social-empty">Noch keine Nachrichten. Sag Hallo! 👋</div>}<div ref={endRef}/></div>
      <form className="social-compose" onSubmit={send}><input value={draft} onChange={event => setDraft(event.target.value)} maxLength={1000} placeholder={`Nachricht an ${activeUser ? activeUser.displayName : rooms.find(room => room.id === activeRoom)?.name || 'OleChat'} …`} aria-label="Nachricht"/><button disabled={!draft.trim()} aria-label="Senden"><Send size={16}/></button></form>
    </section>
  </div>
}

export function NetworkApp({ csrfToken, user }: ApiOptions & { user: Profile }) {
  const [online, setOnline] = useState<PresenceUser[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [files, setFiles] = useState<{ id: string; name: string; kind: string }[]>([])
  const [shares, setShares] = useState<Share[]>([])
  const [sentShares, setSentShares] = useState<SentShare[]>([])
  const [shareFile, setShareFile] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<Share | null>(null)
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = async () => {
    try {
      const [userData, fileData, shareData, sentData] = await Promise.all([
        request<{ users: User[] }>('/api/social/users', csrfToken),
        request<{ items: { id: string; name: string; kind: string }[] }>('/api/files?all=true', csrfToken),
        request<{ shares: Share[] }>('/api/social/shares', csrfToken),
        request<{ shares: SentShare[] }>('/api/social/shares/sent', csrfToken),
      ])
      setUsers(userData.users); setFiles(fileData.items.filter(file => file.kind === 'text' || file.kind === 'image')); setShares(shareData.shares); setSentShares(sentData.shares)
    } catch (issue) { setStatus(issue instanceof Error ? issue.message : 'Netzwerk konnte nicht geladen werden.') }
  }
  useEffect(() => {
    const connection = io({ transports: ['websocket', 'polling'] })
    const stopTracking = trackActivity(connection)
    connection.on('presence:update', setOnline); connection.emit('presence:get', setOnline)
    void refresh(); return () => { stopTracking(); connection.disconnect() }
  }, [csrfToken])
  const share = async (recipientId: string) => {
    if (!shareFile[recipientId]) return setStatus('Wähle zuerst eine Textdatei aus.')
    setBusy(true)
    try { await request('/api/social/shares', csrfToken, { method: 'POST', body: JSON.stringify({ fileId: shareFile[recipientId], recipientId }) }); setStatus('Datei wurde geteilt.') }
    catch (issue) { setStatus(issue instanceof Error ? issue.message : 'Datei konnte nicht geteilt werden.') }
    finally { setBusy(false) }
  }
  const revoke = async (id: string) => {
    try { await request(`/api/social/shares/${id}`, csrfToken, { method: 'DELETE' }); await refresh(); setStatus('Dateifreigabe wurde zurückgenommen.') }
    catch (issue) { setStatus(issue instanceof Error ? issue.message : 'Freigabe konnte nicht entfernt werden.') }
  }
  const moderate = async (target: User, action: 'mute' | 'ban' | 'unban') => {
    const reason = window.prompt('Grund (optional):') || ''
    try {
      if (action === 'unban') await request(`/api/admin/users/${target.id}/ban`, csrfToken, { method: 'DELETE' })
      else await request(`/api/admin/users/${target.id}/${action}`, csrfToken, { method: 'POST', body: JSON.stringify(action === 'mute' ? { minutes: 10, reason } : { reason }) })
      setStatus(action === 'mute' ? `${target.displayName} wurde 10 Minuten stummgeschaltet.` : action === 'ban' ? `${target.displayName} wurde gesperrt.` : 'Sperre aufgehoben.')
    } catch (issue) { setStatus(issue instanceof Error ? issue.message : 'Moderation fehlgeschlagen.') }
  }
  const onlineIds = new Set(online.map(item => item.id))
  return <div className="network-app"><header className="network-heading"><div><h2><Users size={19}/> Netzwerkumgebung</h2><p>OleOS-Nutzer und geteilte Dateien.</p></div><button onClick={() => void refresh()}>Aktualisieren</button></header>{status && <div className="social-error">{status}<button onClick={() => setStatus('')}><X size={13}/></button></div>}
    <section className="network-section"><h3>Nutzer <span>{online.length} online</span></h3>{users.map(contact => <article className="network-user" key={contact.id}><img src={contact.avatar} alt=""/><div className="network-user-name"><b>{contact.displayName}</b><small>{onlineIds.has(contact.id) ? online.find(item => item.id === contact.id)?.status === 'away' ? 'Abwesend' : 'Online' : `@${contact.username}`}</small></div><span className={onlineIds.has(contact.id) ? 'online-dot' : 'offline-dot'}/><select aria-label={`Datei an ${contact.displayName} teilen`} value={shareFile[contact.id] || ''} onChange={event => setShareFile(current => ({ ...current, [contact.id]: event.target.value }))}><option value="">Datei wählen …</option>{files.map(file => <option key={file.id} value={file.id}>{file.kind === 'image' ? 'Bild' : 'Text'} · {file.name}</option>)}</select><button disabled={busy || !shareFile[contact.id]} title="Datei teilen" onClick={() => void share(contact.id)}><Share2 size={14}/> Teilen</button>{user.isAdmin && <div className="moderation-actions"><button title="10 Minuten stumm schalten" onClick={() => void moderate(contact, 'mute')}><Bell size={14}/></button><button title="Sperren" onClick={() => void moderate(contact, 'ban')}><Shield size={14}/></button><button title="Sperre aufheben" onClick={() => void moderate(contact, 'unban')}>↺</button></div>}</article>)}{!users.length && <p className="social-empty">Noch keine weiteren OleOS-Profile. Teile die Seite mit deiner Community!</p>}</section>
    <section className="network-section"><h3>Mit mir geteilt <span>{shares.length}</span></h3>{shares.map(share => <article className="shared-file" key={share.id}><Share2 size={17}/><div><b>{share.file.name}</b><small>von {share.owner.displayName} · {new Date(share.createdAt).toLocaleDateString('de-DE')}</small></div><button onClick={() => setPreview(share)}>Öffnen</button></article>)}{!shares.length && <p className="social-empty">Hier erscheinen Textdateien, die andere mit dir teilen.</p>}</section>
    <section className="network-section"><h3>Von mir geteilt <span>{sentShares.length}</span></h3>{sentShares.map(share => <article className="shared-file" key={share.id}><Share2 size={17}/><div><b>{share.file?.name || 'Datei entfernt'}</b><small>für {share.recipient?.displayName || 'unbekannter Nutzer'}{share.file && !share.file.available ? ' · Datei im Papierkorb' : ''}</small></div><button onClick={() => void revoke(share.id)}>Freigabe beenden</button></article>)}{!sentShares.length && <p className="social-empty">Deine aktiven Freigaben erscheinen hier.</p>}</section>
    {preview && <div className="share-preview-backdrop" onClick={() => setPreview(null)}><section className="share-preview" onClick={event => event.stopPropagation()}><header><b>{preview.file.name}</b><button onClick={() => setPreview(null)} aria-label="Schließen"><X size={16}/></button></header><small>Geteilt von {preview.owner.displayName}</small>{preview.file.kind === 'image' ? <img className="shared-image-preview" src={preview.file.content} alt={preview.file.name}/> : <textarea readOnly value={preview.file.content}/>}<button className="primary-button" onClick={() => setPreview(null)}>Schließen</button></section></div>}
  </div>
}
