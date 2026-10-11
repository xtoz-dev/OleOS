import { useCallback, useEffect, useRef, useState } from 'react'
import { Battery, ChevronRight, Computer, FileText, Folder, HardDrive, HelpCircle, Image, LogOut, Mail as MailIcon, MessageCircle as ChatIcon, Minus, MinusSquare, Monitor, Power, Search, Settings, Shield, Trash2, Volume2, VolumeX, Wifi, X } from 'lucide-react'
import { playSystemSound, type SoundKind } from './audio'
import { MessageCircle } from 'lucide-react'
import { ExplorerApp, NotepadApp, ProfileSettings, RecycleApp, type Profile } from './programs'
import { NetworkApp, OleChat } from './social'
import { MailApp } from './mail'

type AppId = 'computer' | 'files' | 'recycle' | 'network' | 'chat' | 'mail' | 'notepad' | 'paint' | 'settings' | 'about'
type Win = { id: number; app: AppId; title: string; fileId?: string; x: number; y: number; w: number; h: number; z: number; minimized: boolean; maximized: boolean }
const desktopApps: { id: AppId; label: string; icon: string }[] = [
  { id: 'computer', label: 'Arbeitsplatz', icon: '🖥️' }, { id: 'recycle', label: 'Papierkorb', icon: '🗑️' },
  { id: 'network', label: 'Netzwerkumgebung', icon: '🌐' }, { id: 'chat', label: 'OleChat', icon: '💬' }, { id: 'mail', label: 'OleOS Mail', icon: '✉️' }, { id: 'files', label: 'Eigene Dateien', icon: '📁' },
]
const names: Record<AppId, string> = { computer: 'Arbeitsplatz', files: 'Eigene Dateien', recycle: 'Papierkorb', network: 'Netzwerkumgebung', chat: 'OleChat', mail: 'OleOS Mail', notepad: 'Editor', paint: 'Paint', settings: 'Einstellungen', about: 'Über OleOS' }

function AppIcon({ id, size = 20 }: { id: AppId; size?: number }) {
  const props = { size, strokeWidth: 1.7 }
  if (id === 'computer') return <Computer {...props} />
  if (id === 'files') return <Folder {...props} />
  if (id === 'recycle') return <Trash2 {...props} />
  if (id === 'network') return <Wifi {...props} />
  if (id === 'chat') return <ChatIcon {...props} />
  if (id === 'mail') return <MailIcon {...props} />
  if (id === 'notepad') return <FileText {...props} />
  if (id === 'paint') return <Image {...props} />
  if (id === 'settings') return <Settings {...props} />
  return <HelpCircle {...props} />
}

export default function App() {
  const [booting, setBooting] = useState(true)
  const [bootProgress, setBootProgress] = useState(0)
  const [authLoading, setAuthLoading] = useState(true)
  const [user, setUser] = useState<Profile | null>(null)
  const [csrfToken, setCsrfToken] = useState('')
  const [discordConfigured, setDiscordConfigured] = useState(true)
  const [authError, setAuthError] = useState('')
  const [startOpen, setStartOpen] = useState(false)
  const [windows, setWindows] = useState<Win[]>([])
  const [topZ, setTopZ] = useState(10)
  const [clock, setClock] = useState(new Date())
  const [selected, setSelected] = useState<string | null>(null)
  const [soundEnabled, setSoundEnabled] = useState(() => localStorage.getItem('oleos-sound-enabled') !== 'false')
  const [notificationSounds, setNotificationSounds] = useState(() => localStorage.getItem('oleos-notification-sounds') !== 'false')
  const [volume, setVolume] = useState(() => Number(localStorage.getItem('oleos-volume') ?? 35))
  const [volumeOpen, setVolumeOpen] = useState(false)
  const [context, setContext] = useState<{ x: number; y: number } | null>(null)
  const [drag, setDrag] = useState<{ id: number; dx: number; dy: number } | null>(null)
  const [resize, setResize] = useState<{ id: number; sx: number; sy: number; w: number; h: number } | null>(null)
  const nextId = useRef(1)

  useEffect(() => {
    let active = true
    Promise.all([fetch('/api/auth/me', { credentials: 'same-origin' }), fetch('/api/health')]).then(async ([sessionResponse, healthResponse]) => {
      if (!sessionResponse.ok) throw new Error('Sitzung konnte nicht geladen werden.')
      const sessionData = await sessionResponse.json()
      const healthData = healthResponse.ok ? await healthResponse.json() : { discordConfigured: false }
      if (!active) return
      setUser(sessionData.user)
      setCsrfToken(sessionData.csrfToken || '')
      setDiscordConfigured(Boolean(healthData.discordConfigured))
      if (new URLSearchParams(window.location.search).get('auth') === 'error') {
        setAuthError('Die Discord-Anmeldung ist fehlgeschlagen. Bitte versuche es erneut.')
        window.history.replaceState({}, '', window.location.pathname)
      }
    }).catch(() => { if (active) setAuthError('Der OleOS-Server ist gerade nicht erreichbar.') }).finally(() => { if (active) setAuthLoading(false) })
    return () => { active = false }
  }, [])

  const logout = async () => {
    if (!csrfToken) return
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrfToken } })
      if (!response.ok) throw new Error('Abmeldung fehlgeschlagen.')
      setUser(null); setCsrfToken(''); setStartOpen(false); setWindows([])
      const sessionResponse = await fetch('/api/auth/me', { credentials: 'same-origin' })
      const sessionData = await sessionResponse.json()
      setCsrfToken(sessionData.csrfToken || '')
    } catch { setAuthError('Abmeldung fehlgeschlagen. Bitte lade OleOS neu.') }
  }

  useEffect(() => { localStorage.setItem('oleos-sound-enabled', String(soundEnabled)) }, [soundEnabled])
  useEffect(() => { localStorage.setItem('oleos-notification-sounds', String(notificationSounds)) }, [notificationSounds])
  useEffect(() => { localStorage.setItem('oleos-volume', String(volume)) }, [volume])

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 1000)
    const bootTimer = window.setInterval(() => setBootProgress(p => {
      if (p >= 100) { window.clearInterval(bootTimer); window.setTimeout(() => setBooting(false), 350); return 100 }
      return Math.min(100, p + 4)
    }), 65)
    return () => { window.clearInterval(timer); window.clearInterval(bootTimer) }
  }, [])

  const play = (kind: SoundKind) => playSystemSound(kind, volume / 100, soundEnabled && (kind !== 'notify' || notificationSounds))
  const openApp = useCallback((app: AppId, fileId?: string) => {
    playSystemSound('open', volume / 100, soundEnabled)
    const id = nextId.current++
    setTopZ(z => z + 1)
    setWindows(ws => [...ws, { id, app, title: names[app], fileId, x: 100 + (ws.length % 7) * 32, y: 48 + (ws.length % 7) * 26, w: app === 'computer' ? 610 : app === 'mail' ? 760 : 520, h: app === 'computer' ? 410 : app === 'mail' ? 480 : 340, z: topZ + 1, minimized: false, maximized: false }])
    setStartOpen(false); setContext(null)
  }, [topZ, volume, soundEnabled])
  const focus = (id: number) => { setTopZ(z => z + 1); setWindows(ws => ws.map(w => w.id === id ? { ...w, z: topZ + 1, minimized: false } : w)) }
  const update = (id: number, patch: Partial<Win>) => setWindows(ws => ws.map(w => w.id === id ? { ...w, ...patch } : w))
  const close = (id: number) => { play('close'); setWindows(ws => ws.filter(w => w.id !== id)) }
  const toggleMax = (win: Win) => { play(win.maximized ? 'restore' : 'open'); update(win.id, { maximized: !win.maximized, ...(win.maximized ? { x: 100, y: 48, w: 520, h: 340 } : {}) }) }

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (drag) update(drag.id, { x: Math.max(0, e.clientX - drag.dx), y: Math.max(0, e.clientY - drag.dy) })
      if (resize) update(resize.id, { w: Math.max(320, resize.w + e.clientX - resize.sx), h: Math.max(200, resize.h + e.clientY - resize.sy) })
    }
    const onUp = () => { setDrag(null); setResize(null) }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [drag, resize])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.key === 'F4') { e.preventDefault(); setWindows(ws => ws.filter(w => w.z !== Math.max(...ws.filter(x => !x.minimized).map(x => x.z)))) }
      if (e.key === 'Escape') { setStartOpen(false); setContext(null) }
    }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (booting) return <main className="boot-screen"><div className="boot-card"><div className="boot-brand"><span className="brand-mark">O</span><div><b>OleOS</b><small>Persönlicher Desktop</small></div></div><div className="boot-rule"/><div className="boot-status">OleOS wird gestartet<span className="dots">...</span><button className="boot-sound" onClick={() => playSystemSound('boot', volume / 100, soundEnabled)}>♫ Bootmelodie anhören</button></div><div className="progress"><span style={{ width: `${bootProgress}%` }}/></div><div className="boot-foot"><span>Ein Moment für dich.</span><span>{bootProgress}%</span></div></div><div className="boot-version">OleOS 95 · Build 1995.11</div></main>

  if (authLoading) return <main className="login-screen"><div className="login-card login-loading"><span className="brand-mark">O</span><b>OleOS wird vorbereitet…</b><div className="progress"><span style={{width: '70%'}}/></div></div></main>
  if (!user) return <main className="login-screen"><div className="login-card"><div className="login-brand"><span className="brand-mark">O</span><div><b>OleOS</b><small>Willkommen zurück.</small></div></div><div className="login-divider"/><h1>Bei OleOS anmelden</h1><p className="login-description">Dein Desktop und deine Community warten auf dich.</p>{authError && <div className="login-error">{authError}</div>}{!discordConfigured && <div className="login-notice">Discord OAuth ist noch nicht konfiguriert. Ergänze Client-ID und Secret in der <code>.env</code>-Datei und richte die Redirect-URI ein. Die Anleitung steht in der README.</div>}<a className={`discord-login ${!discordConfigured ? 'disabled' : ''}`} href={discordConfigured ? '/api/auth/discord' : undefined} aria-disabled={!discordConfigured}><MessageCircle size={18}/><span>Mit Discord anmelden</span><ChevronRight size={16}/></a><div className="login-footer"><Shield size={14}/> Sichere Anmeldung über Discord OAuth2</div></div><div className="login-build">OleOS 95 · Build 1995.11</div></main>

  return <main className="desktop" style={{ backgroundColor: user.desktopColor || '#087d7e' }} onMouseDown={() => { setStartOpen(false); setContext(null) }} onClickCapture={e => { if ((e.target as HTMLElement).closest('[data-silent]')) return; play('click') }} onContextMenu={e => { if ((e.target as HTMLElement).closest('.window, .taskbar, .desktop-icon, .start-menu')) return; e.preventDefault(); setContext({ x: e.clientX, y: e.clientY }) }} onClick={e => { if (e.target === e.currentTarget) setSelected(null) }}>
    <div className="desktop-grain" />
    <div className="desktop-icons">{desktopApps.map(item => <button key={item.id} className={`desktop-icon ${selected === item.id ? 'selected' : ''}`} onClick={e => { e.stopPropagation(); setSelected(item.id) }} onDoubleClick={e => { e.stopPropagation(); openApp(item.id) }}><span className="emoji-icon">{item.icon}</span><span>{item.label}</span></button>)}
      <button className={`desktop-icon ${selected === 'notepad' ? 'selected' : ''}`} onClick={e => { e.stopPropagation(); setSelected('notepad') }} onDoubleClick={() => openApp('notepad')}><span className="emoji-icon">📝</span><span>Editor</span></button>
    </div>

    {windows.filter(w => !w.minimized).map(win => <section key={win.id} className={`window ${win.maximized ? 'maximized' : ''}`} style={{ left: win.maximized ? 0 : win.x, top: win.maximized ? 0 : win.y, width: win.maximized ? '100%' : win.w, height: win.maximized ? 'calc(100% - 42px)' : win.h, zIndex: win.z }} onMouseDown={() => focus(win.id)}>
      <header className="titlebar" onMouseDown={e => { if ((e.target as HTMLElement).closest('.win-controls')) return; if (!win.maximized) setDrag({ id: win.id, dx: e.clientX - win.x, dy: e.clientY - win.y }) }} onDoubleClick={() => toggleMax(win)}><span className="title-icon"><AppIcon id={win.app} size={15}/></span><b>{win.title}</b><div className="win-controls"><button aria-label="Minimieren" onClick={() => { play('minimize'); update(win.id, { minimized: true }) }}><Minus size={13}/></button><button aria-label="Maximieren" onClick={() => toggleMax(win)}><MinusSquare size={13}/></button><button aria-label="Schließen" onClick={() => close(win.id)}><X size={14}/></button></div></header>
      <div className="window-menubar"><span>Datei</span><span>Bearbeiten</span><span>Ansicht</span><span>?</span></div><div className="window-body">{win.app === 'computer' ? <><div className="explorer-toolbar"><button>← Zurück</button><button>↑ Eine Ebene</button><div className="address"><span>Adresse</span><b>Arbeitsplatz</b></div></div><div className="explorer-content"><div className="explorer-group">Laufwerke</div><button className="explorer-item" onDoubleClick={() => openApp('files')}><HardDrive size={32} color="#245b9b"/><span>Lokaler Datenträger (C:)</span><small>OleOS</small></button><div className="explorer-group">Systemordner</div><div className="explorer-shortcuts">{(['files','network','recycle'] as AppId[]).map(id => <button key={id} className="explorer-item" onDoubleClick={() => openApp(id)}><AppIcon id={id} size={28}/><span>{names[id]}</span></button>)}</div></div><div className="statusbar">4 Objekte</div></> : <AppContents app={win.app} onOpen={openApp} initialFileId={win.fileId} user={user} onUserChange={setUser} csrfToken={csrfToken} soundEnabled={soundEnabled} setSoundEnabled={setSoundEnabled} notificationSounds={notificationSounds} setNotificationSounds={setNotificationSounds} volume={volume} setVolume={setVolume} play={play}/>}</div>
      {!win.maximized && <div className="resize-grip" onMouseDown={e => { e.stopPropagation(); setResize({ id: win.id, sx: e.clientX, sy: e.clientY, w: win.w, h: win.h }) }}/ >}
    </section>)}

    {context && <div className="context-menu" style={{ left: context.x, top: context.y }} onMouseDown={e => e.stopPropagation()}>{[['Ansicht', Monitor], ['Aktualisieren', Search], ['Neu', FileText], ['Eigenschaften', Settings]].map(([label, Icon]) => <button key={label as string} onClick={() => setContext(null)}><Icon size={14}/>{label as string}</button>)}</div>}
    {startOpen && <div className="start-menu" onMouseDown={e => e.stopPropagation()}><div className="start-vertical"><b>OleOS</b><small>DESKTOP</small></div><div className="start-items"><button onClick={() => openApp('computer')}><AppIcon id="computer"/>Arbeitsplatz</button><button onClick={() => openApp('files')}><AppIcon id="files"/>Eigene Dateien</button><button onClick={() => openApp('network')}><AppIcon id="network"/>Netzwerkumgebung</button><button onClick={() => openApp('chat')}><AppIcon id="chat"/>OleChat</button><button onClick={() => openApp('mail')}><AppIcon id="mail"/>OleOS Mail</button><div className="start-divider"/><button onClick={() => openApp('notepad')}><AppIcon id="notepad"/>Editor</button><button onClick={() => openApp('paint')}><AppIcon id="paint"/>Paint</button><button onClick={() => openApp('settings')}><AppIcon id="settings"/>Einstellungen <ChevronRight size={14} className="end-icon"/></button><button onClick={() => openApp('about')}><AppIcon id="about"/>Über OleOS</button><div className="start-divider"/><button onClick={logout}><LogOut size={18}/>Benutzer wechseln</button><button onClick={logout}><Power size={18}/>Abmelden</button></div></div>}
    <footer className="taskbar" onMouseDown={e => e.stopPropagation()}><button className={`start-button ${startOpen ? 'pressed' : ''}`} onClick={() => setStartOpen(v => !v)}><span className="mini-brand">O</span><b>Start</b></button><div className="task-separator"/><div className="quicklaunch"><button title="Arbeitsplatz" onClick={() => openApp('computer')}><Computer size={17}/></button><button title="Editor" onClick={() => openApp('notepad')}><FileText size={16}/></button></div><div className="task-separator"/><div className="task-buttons">{windows.map(w => <button key={w.id} className={`task-button ${!w.minimized ? 'active' : ''}`} onClick={() => w.minimized ? update(w.id, { minimized: false }) : update(w.id, { minimized: true })}><AppIcon id={w.app} size={14}/><span>{w.title}</span></button>)}</div><div className="task-user"><img src={user.avatar} alt=""/><span>{user.displayName}</span></div><div className="system-tray"><span className="tray-signal"><Wifi size={14}/></span><span className="tray-dot"><Battery size={14}/></span><button className="volume-button" aria-label={soundEnabled && volume > 0 ? 'Lautstärke' : 'Stumm'} onClick={() => setVolumeOpen(v => !v)}>{soundEnabled && volume > 0 ? <Volume2 size={15}/> : <VolumeX size={15}/>}</button><span className="clock">{clock.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}<small>{clock.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })}</small></span></div>{volumeOpen && <div className="volume-panel" onMouseDown={e => e.stopPropagation()}><div className="volume-heading"><Volume2 size={15}/><b>Lautstärke</b><span>{volume}%</span></div><input aria-label="Lautstärke" type="range" min="0" max="100" value={volume} onChange={e => setVolume(Number(e.target.value))}/><label><input type="checkbox" checked={!soundEnabled} onChange={e => setSoundEnabled(!e.target.checked)}/> Stumm</label><button onClick={() => playSystemSound('notify', volume / 100, soundEnabled)}>Sound testen</button></div>}</footer>
  </main>
}

function AppContents({ app, onOpen, initialFileId, user, onUserChange, csrfToken, soundEnabled, setSoundEnabled, notificationSounds, setNotificationSounds, volume, setVolume, play }: { app: AppId; onOpen: (id: AppId, fileId?: string) => void; initialFileId?: string; user: Profile; onUserChange: (user: Profile) => void; csrfToken: string; soundEnabled: boolean; setSoundEnabled: (enabled: boolean) => void; notificationSounds: boolean; setNotificationSounds: (enabled: boolean) => void; volume: number; setVolume: (volume: number) => void; play: (kind: SoundKind) => void }) {
  if (app === 'about') return <div className="about-content"><div className="about-logo"><span className="brand-mark">O</span><div><b>OleOS</b><small>Version 1.0</small></div></div><p>Ein kleiner Retro-Desktop für große Ideen.</p><p>OleOS verbindet den Charme klassischer Computer mit einem Ort, an dem Menschen zusammenkommen.</p><div className="about-footer">© 2026 OleOS · Mit Sorgfalt gebaut.</div></div>
  if (app === 'files') return <ExplorerApp csrfToken={csrfToken} openText={id => onOpen('notepad', id)}/>
  if (app === 'recycle') return <RecycleApp csrfToken={csrfToken}/>
  if (app === 'network') return <NetworkApp csrfToken={csrfToken} user={user}/>
  if (app === 'chat') return <OleChat csrfToken={csrfToken} user={user} play={play}/>
  if (app === 'mail') return <MailApp csrfToken={csrfToken} userId={user.id}/>
  if (app === 'settings') return <div className="settings-content"><ProfileSettings csrfToken={csrfToken} user={user} onUserChange={onUserChange}/><div className="sound-settings"><div className="sound-settings-heading"><Volume2 size={18}/><div><b>Systemsounds</b><small>Melodien werden direkt im Browser erzeugt.</small></div></div><label className="sound-toggle"><input type="checkbox" checked={soundEnabled} onChange={e => setSoundEnabled(e.target.checked)}/> Systemsounds aktivieren</label><label className="sound-toggle"><input type="checkbox" checked={notificationSounds} onChange={e => setNotificationSounds(e.target.checked)}/> Benachrichtigungen vertonen</label><label className="volume-setting">Lautstärke <span>{volume}%</span><input type="range" min="0" max="100" value={volume} onChange={e => setVolume(Number(e.target.value))} disabled={!soundEnabled}/></label><div className="sound-samples">{([['open','Fenster'],['notify','Hinweis'],['error','Fehler']] as [SoundKind,string][]).map(([kind,label])=><button key={kind} onClick={() => play(kind)} disabled={!soundEnabled || (kind === 'notify' && !notificationSounds)}>{label} testen</button>)}</div></div></div>
  if (app === 'notepad') return <NotepadApp csrfToken={csrfToken} initialFileId={initialFileId}/>
  if (app === 'paint') return <div className="paint-content"><div className="paint-tools"><span>Werkzeuge</span>{['✥','✎','▰','▱','◯','╱'].map((icon,i) => <button key={i}>{icon}</button>)}<span>Farben</span>{['#101820','#ec6a4b','#e1b44c','#4d8c74','#5498bc','#eee5d6'].map(c=><button key={c} className="color-swatch" style={{background:c}} aria-label={`Farbe ${c}`}/>)}</div><canvas width={580} height={280} className="paint-canvas"/></div>
  return <div className="placeholder-content"><Monitor size={42}/><h2>OleOS</h2><p>Alles bereit, wenn du es bist.</p><button className="primary-button" onClick={() => onOpen('about')}>Mehr erfahren</button></div>
}

