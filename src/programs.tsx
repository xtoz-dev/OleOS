import { useEffect, useState } from 'react'
import { ArrowLeft, FilePlus2, FileText, Folder, FolderPlus, Image, RotateCcw, Save, Trash2, X } from 'lucide-react'

export type Profile = { id: string; discordId: string; username: string; displayName: string; avatar: string; desktopColor: string; theme: string; isAdmin?: boolean }
type FileItem = { id: string; name: string; kind: 'folder' | 'text' | 'image'; content?: string | null; parentId: string | null; trashedAt: string | null; updatedAt: string }
type ApiOptions = { csrfToken: string }

async function api<T>(url: string, options: ApiOptions, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': options.csrfToken, ...(init.headers || {}) },
  })
  if (!response.ok) {
    const data = await response.json().catch(() => null)
    throw new Error(data?.error || `Anfrage fehlgeschlagen (${response.status}).`)
  }
  return response.status === 204 ? undefined as T : response.json()
}

export function ExplorerApp({ csrfToken, openText }: ApiOptions & { openText: (id: string) => void }) {
  const [folderId, setFolderId] = useState<string | null>(null)
  const [items, setItems] = useState<FileItem[]>([])
  const [allItems, setAllItems] = useState<FileItem[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = async () => {
    try {
      const [listing, everything] = await Promise.all([
        api<{ items: FileItem[] }>(`/api/files?folder=${encodeURIComponent(folderId || '')}`, { csrfToken }),
        api<{ items: FileItem[] }>('/api/files?all=true', { csrfToken }),
      ])
      setItems(listing.items); setAllItems(everything.items); setError('')
    } catch (e) { setError(e instanceof Error ? e.message : 'Dateien konnten nicht geladen werden.') }
  }
  useEffect(() => { void load() }, [folderId])
  const create = async (kind: 'folder' | 'text') => {
    const defaultName = kind === 'folder' ? 'Neuer Ordner' : 'Unbenannt.txt'
    const name = window.prompt(kind === 'folder' ? 'Name des neuen Ordners:' : 'Name der neuen Textdatei:', defaultName)
    if (!name?.trim()) return
    setBusy(true)
    try {
      const created = await api<{ item: FileItem }>('/api/files', { csrfToken }, { method: 'POST', body: JSON.stringify({ name: name.trim(), kind, parentId: folderId }) })
      await load()
      if (kind === 'text') openText(created.item.id)
    } catch (e) { setError(e instanceof Error ? e.message : 'Datei konnte nicht angelegt werden.') }
    finally { setBusy(false) }
  }
  const rename = async (item: FileItem) => {
    const name = window.prompt('Neuer Name:', item.name)
    if (!name?.trim() || name.trim() === item.name) return
    try { await api(`/api/files/${item.id}`, { csrfToken }, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) }); await load() }
    catch (e) { setError(e instanceof Error ? e.message : 'Umbenennen fehlgeschlagen.') }
  }
  const move = async (item: FileItem, parentId: string | null) => {
    try { await api(`/api/files/${item.id}`, { csrfToken }, { method: 'PATCH', body: JSON.stringify({ parentId }) }); await load() }
    catch (e) { setError(e instanceof Error ? e.message : 'Verschieben fehlgeschlagen.') }
  }
  const trash = async (item: FileItem) => {
    if (!window.confirm(`„${item.name}“ in den Papierkorb verschieben?`)) return
    try { await api(`/api/files/${item.id}`, { csrfToken }, { method: 'DELETE' }); await load() }
    catch (e) { setError(e instanceof Error ? e.message : 'Löschen fehlgeschlagen.') }
  }
  const folders = allItems.filter(item => item.kind === 'folder')
  return <div className="fs-app">
    <div className="fs-toolbar"><button onClick={() => setFolderId(null)} disabled={!folderId}><ArrowLeft size={14}/> Zurück zu Eigene Dateien</button><span>{folderId ? allItems.find(x => x.id === folderId)?.name || 'Ordner' : 'Eigene Dateien'}</span><div className="fs-toolbar-spacer"/><button disabled={busy} onClick={() => void create('folder')}><FolderPlus size={14}/> Ordner</button><button disabled={busy} onClick={() => void create('text')}><FilePlus2 size={14}/> Textdatei</button></div>
    {error && <div className="fs-error">{error}<button aria-label="Schließen" onClick={() => setError('')}><X size={13}/></button></div>}
    <div className="fs-list"><div className="fs-list-head"><span>Name</span><span>Typ</span><span>Aktionen</span></div>
      {items.map(item => <div className="fs-row" key={item.id}><button className="fs-name" onDoubleClick={() => item.kind === 'folder' ? setFolderId(item.id) : item.kind === 'text' ? openText(item.id) : undefined}>{item.kind === 'folder' ? <Folder size={20}/> : item.kind === 'image' ? <Image size={19}/> : <FileText size={19}/>}<span>{item.name}</span></button><span className="fs-kind">{item.kind === 'folder' ? 'Ordner' : item.kind === 'image' ? 'Bild' : 'Textdokument'}</span><div className="fs-actions"><select aria-label={`${item.name} verschieben`} value={item.parentId || ''} onChange={e => void move(item, e.target.value || null)}><option value="">Eigene Dateien</option>{folders.filter(folder => folder.id !== item.id).map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select><button title="Umbenennen" onClick={() => void rename(item)}>Umbenennen</button><button title="In Papierkorb verschieben" onClick={() => void trash(item)}><Trash2 size={14}/></button></div></div>)}
      {!items.length && <div className="fs-empty">{busy ? 'Wird gespeichert …' : 'Dieser Ordner ist leer. Lege einen Ordner oder eine Textdatei an.'}</div>}
    </div>
  </div>
}

export function RecycleApp({ csrfToken }: ApiOptions) {
  const [items, setItems] = useState<FileItem[]>([])
  const [error, setError] = useState('')
  const load = async () => { try { setItems((await api<{ items: FileItem[] }>('/api/files?trash=true', { csrfToken })).items); setError('') } catch (e) { setError(e instanceof Error ? e.message : 'Papierkorb konnte nicht geladen werden.') } }
  useEffect(() => { void load() }, [])
  const restore = async (item: FileItem) => { try { await api(`/api/files/${item.id}/restore`, { csrfToken }, { method: 'POST' }); await load() } catch (e) { setError(e instanceof Error ? e.message : 'Wiederherstellen fehlgeschlagen.') } }
  const remove = async (item: FileItem) => { if (!window.confirm(`„${item.name}“ endgültig löschen?`)) return; try { await api(`/api/files/${item.id}/permanent`, { csrfToken }, { method: 'DELETE' }); await load() } catch (e) { setError(e instanceof Error ? e.message : 'Löschen fehlgeschlagen.') } }
  return <div className="fs-app"><div className="fs-toolbar"><span>Papierkorb</span><div className="fs-toolbar-spacer"/><button onClick={() => void load()}>Aktualisieren</button></div>{error && <div className="fs-error">{error}</div>}<div className="fs-list"><div className="fs-list-head"><span>Name</span><span>Typ</span><span>Aktionen</span></div>{items.map(item=><div className="fs-row" key={item.id}><div className="fs-name">{item.kind === 'folder' ? <Folder size={20}/> : <FileText size={19}/>}<span>{item.name}</span></div><span className="fs-kind">{item.kind === 'folder' ? 'Ordner' : 'Textdokument'}</span><div className="fs-actions"><button onClick={() => void restore(item)}><RotateCcw size={14}/> Wiederherstellen</button><button title="Endgültig löschen" onClick={() => void remove(item)}><Trash2 size={14}/></button></div></div>)}{!items.length && <div className="fs-empty">Der Papierkorb ist leer.</div>}</div></div>
}

export function NotepadApp({ csrfToken, initialFileId }: ApiOptions & { initialFileId?: string }) {
  const [files, setFiles] = useState<FileItem[]>([])
  const [fileId, setFileId] = useState('')
  const [name, setName] = useState('Unbenannt.txt')
  const [content, setContent] = useState('')
  const [status, setStatus] = useState('Bereit')
  const [error, setError] = useState('')
  const loadFiles = async () => { try { setFiles((await api<{ items: FileItem[] }>('/api/files?all=true&type=text', { csrfToken })).items) } catch (e) { setError(e instanceof Error ? e.message : 'Dateiliste konnte nicht geladen werden.') } }
  const openFile = async (id: string) => {
    try { const result = await api<{ item: FileItem }>(`/api/files/${id}`, { csrfToken }); setFileId(result.item.id); setName(result.item.name); setContent(result.item.content || ''); setStatus('Geöffnet'); setError('') }
    catch (e) { setError(e instanceof Error ? e.message : 'Datei konnte nicht geöffnet werden.') }
  }
  useEffect(() => { void loadFiles() }, [])
  useEffect(() => { if (initialFileId) void openFile(initialFileId) }, [initialFileId])
  const save = async () => {
    try {
      const saved = fileId
        ? await api<{ item: FileItem }>(`/api/files/${fileId}`, { csrfToken }, { method: 'PATCH', body: JSON.stringify({ name, content }) })
        : await api<{ item: FileItem }>('/api/files', { csrfToken }, { method: 'POST', body: JSON.stringify({ name, content, kind: 'text', parentId: null }) })
      setFileId(saved.item.id); setName(saved.item.name); setStatus('Gespeichert'); setError(''); await loadFiles()
    } catch (e) { setError(e instanceof Error ? e.message : 'Speichern fehlgeschlagen.') }
  }
  return <div className="notepad-app"><div className="notepad-toolbar"><select aria-label="Textdatei öffnen" value="" onChange={e => { if (e.target.value) void openFile(e.target.value) }}><option value="">Datei öffnen …</option>{files.map(file=><option key={file.id} value={file.id}>{file.name}</option>)}</select><input aria-label="Dateiname" value={name} onChange={e => setName(e.target.value)} maxLength={100}/><button onClick={() => void save()}><Save size={14}/> Speichern</button><button onClick={() => { setFileId(''); setName('Unbenannt.txt'); setContent(''); setStatus('Neue Datei') }}>Neu</button></div>{error && <div className="fs-error">{error}</div>}<textarea aria-label="Editor" value={content} onChange={e => { setContent(e.target.value); setStatus('Nicht gespeichert') }} placeholder="Schreibe hier deine Gedanken …"/><div className="notepad-status">{status} · {content.length} Zeichen</div></div>
}

export function ProfileSettings({ csrfToken, user, onUserChange }: ApiOptions & { user: Profile; onUserChange: (user: Profile) => void }) {
  const [displayName, setDisplayName] = useState(user.displayName)
  const [desktopColor, setDesktopColor] = useState(user.desktopColor || '#087d7e')
  const [status, setStatus] = useState('')
  const colors = [{ name: 'OleOS Türkis', value: '#087d7e' }, { name: 'Mitternacht', value: '#243651' }, { name: 'Moos', value: '#426b54' }, { name: 'Pflaume', value: '#6b4a71' }, { name: 'Sand', value: '#8a714d' }]
  useEffect(() => { setDisplayName(user.displayName); setDesktopColor(user.desktopColor || '#087d7e') }, [user])
  const save = async () => {
    try {
      const result = await api<{ user: Profile }>('/api/auth/profile', { csrfToken }, { method: 'POST', body: JSON.stringify({ displayName, desktopColor }) })
      onUserChange(result.user); setStatus('Profil gespeichert.')
    } catch (e) { setStatus(e instanceof Error ? e.message : 'Profil konnte nicht gespeichert werden.') }
  }
  return <div className="profile-settings"><h2>OleOS anpassen</h2><p>Dein Desktop, deine Regeln.</p><section className="profile-card"><b>Profil</b><label>Anzeigename<input value={displayName} onChange={e => setDisplayName(e.target.value)} maxLength={32}/></label></section><section className="profile-card"><b>Desktop-Hintergrund</b><div className="background-choices">{colors.map(color=><button key={color.value} className={desktopColor === color.value ? 'chosen' : ''} title={color.name} aria-label={color.name} style={{ backgroundColor: color.value }} onClick={() => setDesktopColor(color.value)}/>)}</div></section><button className="profile-save" onClick={() => void save()}>Änderungen speichern</button>{status && <div className="setting-note">{status}</div>}</div>
}
