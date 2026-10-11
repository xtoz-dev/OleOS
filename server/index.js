import 'dotenv/config'
import crypto from 'node:crypto'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import session from 'express-session'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import { prisma } from './prisma.js'
import { Server as SocketServer } from 'socket.io'
import { z } from 'zod'
import { initializeDatabase } from './database.js'

const app = express()
const httpServer = createServer(app)
const io = new SocketServer(httpServer, { serveClient: false, maxHttpBufferSize: 64 * 1024, pingInterval: 25000, pingTimeout: 20000 })
const port = Number(process.env.PORT || process.env.API_PORT || 3001)
const appOrigin = process.env.APP_ORIGIN || process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`
const isProduction = process.env.NODE_ENV === 'production'
const secret = process.env.SESSION_SECRET
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

if (!secret || Buffer.byteLength(secret) < 32) {
  throw new Error('SESSION_SECRET must be set and contain at least 32 bytes. Copy .env.example and generate a secret.')
}

app.disable('x-powered-by')
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"], baseUri: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https://cdn.discordapp.com'], styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"], connectSrc: ["'self'"], formAction: ["'self'", 'https://discord.com'],
    },
  },
  crossOriginEmbedderPolicy: false,
}))
app.use(express.json({ limit: '2200kb', strict: true }))

class PrismaSessionStore extends session.Store {
  get(sid, callback) {
    prisma.session.findUnique({ where: { sid } }).then(record => {
      if (!record || record.expires <= new Date()) {
        if (record) void prisma.session.delete({ where: { sid } }).catch(() => undefined)
        callback(null, null)
        return
      }
      callback(null, JSON.parse(record.data))
    }).catch(error => callback(error))
  }
  set(sid, sess, callback = () => undefined) {
    const expires = sess.cookie?.expires ? new Date(sess.cookie.expires) : new Date(Date.now() + 7 * 86400000)
    prisma.session.upsert({
      where: { sid }, create: { sid, data: JSON.stringify(sess), expires }, update: { data: JSON.stringify(sess), expires },
    }).then(() => callback(null)).catch(error => callback(error))
  }
  destroy(sid, callback = () => undefined) {
    prisma.session.deleteMany({ where: { sid } }).then(() => callback(null)).catch(error => callback(error))
  }
  touch(sid, sess, callback = () => undefined) {
    const expires = sess.cookie?.expires ? new Date(sess.cookie.expires) : new Date(Date.now() + 7 * 86400000)
    prisma.session.updateMany({ where: { sid }, data: { expires } }).then(() => callback(null)).catch(error => callback(error))
  }
  clear(callback = () => undefined) { prisma.session.deleteMany().then(() => callback(null)).catch(error => callback(error)) }
  length(callback) { prisma.session.count().then(count => callback(null, count)).catch(error => callback(error)) }
}

const sessionMiddleware = session({
  name: 'oleos.sid', secret, store: new PrismaSessionStore(), resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, secure: isProduction, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000, path: '/' },
})
app.use(sessionMiddleware)
io.engine.use(sessionMiddleware)

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Zu viele Anmeldeversuche. Bitte später erneut versuchen.' } })
const idSchema = z.string().regex(/^\d{17,20}$/)
const displayNameSchema = z.string().trim().min(1).max(32).regex(/^[\p{L}\p{N} _.-]+$/u, 'Der Anzeigename enthält ungültige Zeichen.')
const fileNameSchema = z.string().trim().min(1).max(100).regex(/^[^/\\\u0000-\u001f]+$/u, 'Der Dateiname ist ungültig.')
const contentSchema = z.string().max(1024 * 1024, 'Textdateien dürfen höchstens 1 MB groß sein.')
const imageContentSchema = z.string().max(2 * 1024 * 1024).regex(/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/, 'Bilder müssen als PNG, JPEG, GIF oder WebP vorliegen und Base64-kodiert sein.')
const fileKindSchema = z.enum(['folder', 'text', 'image'])

function isAllowedAppOrigin(origin) {
  if (!origin) return false
  if (origin === appOrigin) return true
  if (isProduction) return false
  try {
    const url = new URL(origin)
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  } catch { return false }
}
function sameOrigin(req, res, next) {
  if (!isAllowedAppOrigin(req.get('origin'))) return res.status(403).json({ error: 'Ungültige Herkunft der Anfrage.' })
  next()
}
function safeAppOrigin(req) {
  const referer = req.get('referer')
  if (referer) {
    try { const origin = new URL(referer).origin; if (isAllowedAppOrigin(origin)) return origin } catch { /* use configured app origin */ }
  }
  return appOrigin
}
function requireCsrf(req, res, next) {
  const token = req.get('x-csrf-token')
  const expected = req.session.csrfToken
  if (!token || !expected || token.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
    return res.status(403).json({ error: 'Sitzung abgelaufen. Bitte erneut anmelden.' })
  }
  next()
}
function currentUser(req) {
  if (!req.session.userId) return Promise.resolve(null)
  return prisma.user.findUnique({ where: { id: req.session.userId }, select: { id: true, discordId: true, username: true, displayName: true, avatarHash: true, desktopColor: true, theme: true } })
}
function userPayload(user) {
  if (!user) return null
  const avatar = user.avatarHash
    ? `https://cdn.discordapp.com/avatars/${user.discordId}/${user.avatarHash}.png?size=128`
    : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.discordId) >> 22n) % 6}.png`
  return { id: user.id, discordId: user.discordId, username: user.username, displayName: user.displayName, avatar, desktopColor: user.desktopColor, theme: user.theme, isAdmin: adminIds.has(user.discordId) }
}
const presence = new Map()
const lastActivity = new Map()
const adminIds = new Set((process.env.ADMIN_DISCORD_IDS || '').split(',').map(value => value.trim()).filter(Boolean))
const isAdmin = user => Boolean(user && adminIds.has(user.discordId))
function presencePayload() { return [...presence.values()].map(({ user }) => ({ id: user.id, displayName: user.displayName, username: user.username, avatar: userPayload(user).avatar, status: Date.now() - (lastActivity.get(user.id) || 0) > 5 * 60 * 1000 ? 'away' : 'online' })) }
function broadcastPresence() { io.emit('presence:update', presencePayload()) }
const presenceTimer = setInterval(() => { if (presence.size) broadcastPresence() }, 60000)
presenceTimer.unref()
function validSocketCsrf(socket, token) {
  const expected = socket.request.session?.csrfToken
  return typeof token === 'string' && typeof expected === 'string' && token.length === expected.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))
}
function socketError(callback, message) { if (typeof callback === 'function') callback({ error: message }) }
function redirectAuthError(req, res) {
  return res.redirect(`${req.session.oauthAppOrigin || safeAppOrigin(req)}/?auth=error`)
}
function sessionCall(req, action) {
  return new Promise((resolve, reject) => req.session[action](error => error ? reject(error) : resolve()))
}

app.get('/api/health', (_req, res) => res.json({ ok: true, discordConfigured: Boolean(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET && (process.env.DISCORD_REDIRECT_URI || appOrigin.startsWith('https://'))) }))
app.get('/api/auth/me', async (req, res, next) => {
  try {
    if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex')
    res.set('Cache-Control', 'no-store')
    res.json({ user: userPayload(await currentUser(req)), csrfToken: req.session.csrfToken })
  } catch (error) { next(error) }
})

app.get('/api/auth/discord', authLimiter, (req, res) => {
  const { DISCORD_CLIENT_ID } = process.env
  const redirectUri = process.env.DISCORD_REDIRECT_URI || `${appOrigin}/api/auth/discord/callback`
  if (!DISCORD_CLIENT_ID || !redirectUri || !process.env.DISCORD_CLIENT_SECRET) return res.status(503).send('Discord-Anmeldung ist noch nicht konfiguriert. Bitte trage die Discord-Zugangsdaten in die Server-Umgebung ein.')
  const state = crypto.randomBytes(32).toString('base64url')
  req.session.oauthState = state
  req.session.oauthAppOrigin = safeAppOrigin(req)
  req.session.save(error => {
    if (error) return res.status(500).send('Die Sitzung konnte nicht gespeichert werden.')
    const authorize = new URL('https://discord.com/oauth2/authorize')
    authorize.searchParams.set('client_id', DISCORD_CLIENT_ID)
    authorize.searchParams.set('response_type', 'code')
    authorize.searchParams.set('redirect_uri', redirectUri)
    authorize.searchParams.set('scope', 'identify')
    authorize.searchParams.set('state', state)
    res.redirect(authorize.toString())
  })
})

app.get('/api/auth/discord/callback', authLimiter, async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : ''
  const state = typeof req.query.state === 'string' ? req.query.state : ''
  const expected = req.session.oauthState
  const returnOrigin = req.session.oauthAppOrigin || safeAppOrigin(req)
  delete req.session.oauthState
  if (!code || !state || !expected || state.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expected))) return redirectAuthError(req, res)
  try {
    const credentials = new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code', code,
      redirect_uri: process.env.DISCORD_REDIRECT_URI || `${appOrigin}/api/auth/discord/callback`,
    })
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: credentials, signal: AbortSignal.timeout(10000),
    })
    if (!tokenResponse.ok) return redirectAuthError(req, res)
    const token = await tokenResponse.json()
    const profileResponse = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(10000),
    })
    if (!profileResponse.ok) return redirectAuthError(req, res)
    const profile = await profileResponse.json()
    const discordId = idSchema.safeParse(profile.id)
    const username = z.string().min(1).max(64).safeParse(profile.username)
    const avatarHash = profile.avatar === null ? null : z.string().max(128).safeParse(profile.avatar)
    if (!discordId.success || !username.success || (profile.avatar !== null && !avatarHash.success)) return redirectAuthError(req, res)
    const displayName = z.string().trim().min(1).max(64).safeParse(profile.global_name || profile.username)
    const user = await prisma.user.upsert({
      where: { discordId: discordId.data },
      create: { discordId: discordId.data, username: username.data, displayName: displayName.success ? displayName.data : username.data, avatarHash: profile.avatar === null ? null : avatarHash.data },
      update: { username: username.data, avatarHash: profile.avatar === null ? null : avatarHash.data },
    })
    await sessionCall(req, 'regenerate')
    req.session.userId = user.id
    req.session.csrfToken = crypto.randomBytes(32).toString('hex')
    await sessionCall(req, 'save')
    res.redirect(returnOrigin)
  } catch (error) {
    console.error('Discord OAuth callback failed:', error instanceof Error ? error.message : 'unknown error')
    redirectAuthError(req, res)
  }
})

app.post('/api/auth/logout', sameOrigin, requireCsrf, async (req, res, next) => {
  try {
    await sessionCall(req, 'destroy')
    res.clearCookie('oleos.sid', { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/' })
    res.status(204).end()
  } catch (error) { next(error) }
})

app.post('/api/auth/profile', sameOrigin, requireCsrf, async (req, res, next) => {
  try {
    const user = await currentUser(req)
    if (!user) return res.status(401).json({ error: 'Bitte melde dich zuerst an.' })
    const parsed = z.object({ displayName: displayNameSchema, desktopColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), theme: z.enum(['classic']).optional() }).safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Ungültiger Anzeigename.' })
    const updated = await prisma.user.update({ where: { id: user.id }, data: { ...parsed.data }, select: { id: true, discordId: true, username: true, displayName: true, avatarHash: true, desktopColor: true, theme: true } })
    res.json({ user: userPayload(updated) })
  } catch (error) { next(error) }
})


async function requireLogin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Bitte melde dich mit Discord an.' })
  try {
    const restriction = await prisma.userRestriction.findUnique({ where: { userId: req.session.userId }, select: { bannedAt: true } })
    if (restriction?.bannedAt) return res.status(403).json({ error: 'Dein OleOS-Zugang ist gesperrt.' })
    next()
  } catch (error) { next(error) }
}
function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Bitte melde dich zuerst an.' })
  currentUser(req).then(user => isAdmin(user) ? next() : res.status(403).json({ error: 'Diese Aktion ist der OleOS-Moderation vorbehalten.' })).catch(next)
}

app.get('/api/social/rooms', requireLogin, async (_req, res, next) => {
  try { res.json({ rooms: await prisma.chatRoom.findMany({ orderBy: { createdAt: 'asc' }, select: { id: true, name: true } }) }) } catch (error) { next(error) }
})
const mailUserSelect = { id: true, discordId: true, username: true, displayName: true, avatarHash: true, desktopColor: true, theme: true }
const mailInclude = { sender: { select: mailUserSelect }, recipient: { select: mailUserSelect } }
function mailPayload(message) {
  return { id: message.id, subject: message.subject, body: message.body, readAt: message.readAt, createdAt: message.createdAt, sender: userPayload(message.sender), recipient: userPayload(message.recipient) }
}
app.get('/api/mail', requireLogin, async (req, res, next) => {
  try {
    const folder = req.query.folder === 'sent' ? 'sent' : 'inbox'
    const where = folder === 'sent'
      ? { senderId: req.session.userId, senderDeletedAt: null }
      : { recipientId: req.session.userId, recipientDeletedAt: null }
    const [messages, unreadCount] = await Promise.all([
      prisma.mailMessage.findMany({ where, include: mailInclude, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.mailMessage.count({ where: { recipientId: req.session.userId, recipientDeletedAt: null, readAt: null } }),
    ])
    res.set('Cache-Control', 'no-store').json({ messages: messages.map(mailPayload), unreadCount })
  } catch (error) { next(error) }
})
app.post('/api/mail', sameOrigin, requireCsrf, requireLogin, async (req, res, next) => {
  try {
    const parsed = z.object({ recipientId: z.string().cuid(), subject: z.string().trim().min(1).max(120), body: z.string().trim().min(1).max(10000) }).strict().safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: 'Bitte Empfänger, Betreff und Nachricht prüfen. (Betreff max. 120, Nachricht max. 10.000 Zeichen)' })
    if (parsed.data.recipientId === req.session.userId) return res.status(400).json({ error: 'Du kannst nur an andere OleOS-Nutzer schreiben.' })
    const recipient = await prisma.user.findUnique({ where: { id: parsed.data.recipientId }, select: { id: true } })
    if (!recipient) return res.status(404).json({ error: 'Dieser OleOS-Nutzer wurde nicht gefunden.' })
    const message = await prisma.mailMessage.create({ data: { ...parsed.data, senderId: req.session.userId }, include: mailInclude })
    res.status(201).json({ message: mailPayload(message) })
  } catch (error) { next(error) }
})
app.patch('/api/mail/:id/read', sameOrigin, requireCsrf, requireLogin, async (req, res, next) => {
  try {
    const updated = await prisma.mailMessage.updateMany({ where: { id: req.params.id, recipientId: req.session.userId, recipientDeletedAt: null, readAt: null }, data: { readAt: new Date() } })
    if (!updated.count) {
      const message = await prisma.mailMessage.findFirst({ where: { id: req.params.id, recipientId: req.session.userId, recipientDeletedAt: null }, select: { id: true } })
      if (!message) return res.status(404).json({ error: 'Nachricht nicht gefunden.' })
    }
    res.status(204).end()
  } catch (error) { next(error) }
})
app.delete('/api/mail/:id', sameOrigin, requireCsrf, requireLogin, async (req, res, next) => {
  try {
    const folder = req.query.folder === 'sent' ? 'sent' : 'inbox'
    const where = folder === 'sent'
      ? { id: req.params.id, senderId: req.session.userId, senderDeletedAt: null }
      : { id: req.params.id, recipientId: req.session.userId, recipientDeletedAt: null }
    const data = folder === 'sent' ? { senderDeletedAt: new Date() } : { recipientDeletedAt: new Date() }
    const removed = await prisma.mailMessage.updateMany({ where, data })
    if (!removed.count) return res.status(404).json({ error: 'Nachricht nicht gefunden.' })
    res.status(204).end()
  } catch (error) { next(error) }
})
app.post('/api/social/rooms', sameOrigin, requireCsrf, requireLogin, async (req, res, next) => {
  try {
    const parsed = z.object({ name: z.string().trim().min(2).max(32).regex(/^[\p{L}\p{N} _-]+$/u) }).safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: 'Raumnamen: 2–32 Buchstaben, Zahlen, Leerzeichen, Bindestriche oder Unterstriche.' })
    const exists = await prisma.chatRoom.findUnique({ where: { name: parsed.data.name } })
    if (exists) return res.status(409).json({ error: 'Dieser Raum existiert bereits.' })
    const room = await prisma.chatRoom.create({ data: { name: parsed.data.name } })
    res.status(201).json({ room: { id: room.id, name: room.name } })
  } catch (error) { next(error) }
})
app.get('/api/social/users', requireLogin, async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({ where: { id: { not: req.session.userId } }, orderBy: { displayName: 'asc' }, take: 200, select: { id: true, discordId: true, username: true, displayName: true, avatarHash: true } })
    res.set('Cache-Control', 'no-store').json({ users: users.map(user => ({ ...userPayload(user), isAdmin: adminIds.has(user.discordId) })) })
  } catch (error) { next(error) }
})
app.get('/api/social/shares', requireLogin, async (req, res, next) => {
  try {
    const shares = await prisma.sharedFile.findMany({ where: { recipientId: req.session.userId }, orderBy: { createdAt: 'desc' } })
    const items = await Promise.all(shares.map(async share => {
      const [file, owner] = await Promise.all([
        prisma.fileEntry.findFirst({ where: { id: share.fileId, userId: share.ownerId, trashedAt: null, kind: { in: ['text', 'image'] } }, select: { id: true, name: true, kind: true, content: true } }),
        prisma.user.findUnique({ where: { id: share.ownerId }, select: { id: true, discordId: true, username: true, displayName: true, avatarHash: true } }),
      ])
      return file && owner ? { id: share.id, file, owner: userPayload(owner), createdAt: share.createdAt } : null
    }))
    res.set('Cache-Control', 'no-store').json({ shares: items.filter(Boolean) })
  } catch (error) { next(error) }
})
app.get('/api/social/shares/sent', requireLogin, async (req, res, next) => {
  try {
    const shares = await prisma.sharedFile.findMany({ where: { ownerId: req.session.userId }, orderBy: { createdAt: 'desc' } })
    const items = await Promise.all(shares.map(async share => {
      const [file, recipient] = await Promise.all([
        prisma.fileEntry.findFirst({ where: { id: share.fileId, userId: share.ownerId }, select: { id: true, name: true, kind: true, trashedAt: true } }),
        prisma.user.findUnique({ where: { id: share.recipientId }, select: { id: true, discordId: true, username: true, displayName: true, avatarHash: true } }),
      ])
      return { id: share.id, file: file ? { ...file, available: !file.trashedAt } : null, recipient: recipient ? userPayload(recipient) : null, createdAt: share.createdAt }
    }))
    res.set('Cache-Control', 'no-store').json({ shares: items })
  } catch (error) { next(error) }
})
app.post('/api/social/shares', sameOrigin, requireCsrf, requireLogin, async (req, res, next) => {
  try {
    const parsed = z.object({ fileId: z.string().cuid(), recipientId: z.string().cuid() }).strict().safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: 'Ungültige Freigabe.' })
    const [file, recipient] = await Promise.all([
      prisma.fileEntry.findFirst({ where: { id: parsed.data.fileId, userId: req.session.userId, kind: { in: ['text', 'image'] }, trashedAt: null }, select: { id: true, name: true } }),
      prisma.user.findUnique({ where: { id: parsed.data.recipientId }, select: { id: true } }),
    ])
    if (!file || !recipient || recipient.id === req.session.userId) return res.status(404).json({ error: 'Datei oder Empfänger nicht gefunden.' })
    const share = await prisma.sharedFile.upsert({ where: { fileId_recipientId: { fileId: file.id, recipientId: recipient.id } }, create: { fileId: file.id, ownerId: req.session.userId, recipientId: recipient.id }, update: { ownerId: req.session.userId } })
    io.to(`user:${recipient.id}`).emit('share:new', { name: file.name })
    res.status(201).json({ share: { id: share.id, name: file.name } })
  } catch (error) { next(error) }
})
app.delete('/api/social/shares/:id', sameOrigin, requireCsrf, requireLogin, async (req, res, next) => {
  try {
    const removed = await prisma.sharedFile.deleteMany({ where: { id: req.params.id, ownerId: req.session.userId } })
    if (!removed.count) return res.status(404).json({ error: 'Freigabe nicht gefunden.' })
    res.status(204).end()
  } catch (error) { next(error) }
})
app.post('/api/admin/users/:id/mute', sameOrigin, requireCsrf, requireAdmin, async (req, res, next) => {
  try {
    const parsed = z.object({ minutes: z.number().int().min(1).max(10080), reason: z.string().trim().max(200).optional() }).safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: 'Stummschaltung muss zwischen 1 Minute und 7 Tagen liegen.' })
    await prisma.userRestriction.upsert({ where: { userId: req.params.id }, create: { userId: req.params.id, mutedUntil: new Date(Date.now() + parsed.data.minutes * 60000), reason: parsed.data.reason }, update: { mutedUntil: new Date(Date.now() + parsed.data.minutes * 60000), reason: parsed.data.reason } })
    res.status(204).end()
  } catch (error) { next(error) }
})
app.post('/api/admin/users/:id/ban', sameOrigin, requireCsrf, requireAdmin, async (req, res, next) => {
  try {
    const parsed = z.object({ reason: z.string().trim().max(200).optional() }).safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: 'Ungültiger Moderationsgrund.' })
    await prisma.userRestriction.upsert({ where: { userId: req.params.id }, create: { userId: req.params.id, bannedAt: new Date(), reason: parsed.data.reason }, update: { bannedAt: new Date(), reason: parsed.data.reason } })
    io.in(`user:${req.params.id}`).disconnectSockets(true)
    res.status(204).end()
  } catch (error) { next(error) }
})
app.delete('/api/admin/users/:id/ban', sameOrigin, requireCsrf, requireAdmin, async (req, res, next) => {
  try { await prisma.userRestriction.updateMany({ where: { userId: req.params.id }, data: { bannedAt: null } }); res.status(204).end() } catch (error) { next(error) }
})
app.delete('/api/admin/messages/:id', sameOrigin, requireCsrf, requireAdmin, async (req, res, next) => {
  try {
    const message = await prisma.chatMessage.findUnique({ where: { id: req.params.id }, select: { id: true, roomId: true, senderId: true, recipientId: true } })
    if (!message) return res.status(404).json({ error: 'Nachricht nicht gefunden.' })
    await prisma.chatMessage.update({ where: { id: message.id }, data: { deletedAt: new Date(), content: '[Nachricht von der Moderation entfernt]' } })
    if (message.roomId) io.to(`room:${message.roomId}`).emit('chat:deleted', { id: message.id })
    else { io.to(`user:${message.senderId}`).emit('chat:deleted', { id: message.id }); if (message.recipientId) io.to(`user:${message.recipientId}`).emit('chat:deleted', { id: message.id }) }
    res.status(204).end()
  } catch (error) { next(error) }
})

io.use(async (socket, next) => {
  try {
    const origin = socket.handshake.headers.origin
    if (origin && !isAllowedAppOrigin(origin)) return next(new Error('Ungültige Herkunft der Verbindung.'))
    const sessionData = socket.request.session
    if (!sessionData?.userId) return next(new Error('Bitte melde dich mit Discord an.'))
    const [user, restriction] = await Promise.all([
      prisma.user.findUnique({ where: { id: sessionData.userId }, select: { id: true, discordId: true, username: true, displayName: true, avatarHash: true } }),
      prisma.userRestriction.findUnique({ where: { userId: sessionData.userId } }),
    ])
    if (!user || restriction?.bannedAt) return next(new Error('Dein OleOS-Zugang ist derzeit gesperrt.'))
    socket.data.user = user
    socket.data.isAdmin = isAdmin(user)
    next()
  } catch { next(new Error('OleChat konnte die Sitzung nicht prüfen.')) }
})
io.on('connection', socket => {
  const user = socket.data.user
  socket.join(`user:${user.id}`)
  lastActivity.set(user.id, Date.now())
  const presenceEntry = presence.get(user.id) || { user, sockets: new Set() }
  presenceEntry.sockets.add(socket.id); presence.set(user.id, presenceEntry); broadcastPresence()
  let messageWindow = Date.now(), messageCount = 0
  const consumeRate = () => { if (Date.now() - messageWindow > 60000) { messageWindow = Date.now(); messageCount = 0 } return ++messageCount <= 30 }
  socket.on('presence:get', callback => { if (typeof callback === 'function') callback(presencePayload()) })
  socket.on('presence:active', () => {
    const previous = lastActivity.get(user.id) || 0
    if (Date.now() - previous < 15000) return
    const wasAway = Date.now() - previous > 5 * 60 * 1000
    lastActivity.set(user.id, Date.now())
    if (wasAway) broadcastPresence()
  })
  socket.on('chat:join', async ({ roomId, csrfToken } = {}, callback) => {
    if (!validSocketCsrf(socket, csrfToken)) return socketError(callback, 'Sitzung abgelaufen. Bitte neu laden.')
    const room = await prisma.chatRoom.findUnique({ where: { id: roomId }, select: { id: true } }).catch(() => null)
    if (!room) return socketError(callback, 'Chatraum nicht gefunden.')
    for (const joined of [...socket.rooms]) if (joined.startsWith('room:')) socket.leave(joined)
    socket.join(`room:${room.id}`)
    const messages = await prisma.chatMessage.findMany({ where: { roomId: room.id }, orderBy: { createdAt: 'desc' }, take: 80, select: { id: true, senderId: true, senderName: true, content: true, createdAt: true, deletedAt: true } }).catch(() => [])
    if (typeof callback === 'function') callback({ messages: messages.reverse() })
  })
  socket.on('chat:history-dm', async ({ userId, csrfToken } = {}, callback) => {
    if (!validSocketCsrf(socket, csrfToken)) return socketError(callback, 'Sitzung abgelaufen. Bitte neu laden.')
    const other = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } }).catch(() => null)
    if (!other || other.id === user.id) return socketError(callback, 'Nutzer nicht gefunden.')
    const messages = await prisma.chatMessage.findMany({ where: { roomId: null, OR: [{ senderId: user.id, recipientId: other.id }, { senderId: other.id, recipientId: user.id }] }, orderBy: { createdAt: 'desc' }, take: 80, select: { id: true, senderId: true, recipientId: true, senderName: true, content: true, createdAt: true, deletedAt: true } }).catch(() => [])
    if (typeof callback === 'function') callback({ messages: messages.reverse() })
  })
  socket.on('chat:send-room', async ({ roomId, content, csrfToken } = {}, callback) => {
    if (!validSocketCsrf(socket, csrfToken)) return socketError(callback, 'Sitzung abgelaufen. Bitte neu laden.')
    const clean = z.string().trim().min(1).max(1000).safeParse(content)
    if (!clean.success) return socketError(callback, 'Nachrichten dürfen 1–1000 Zeichen enthalten.')
    if (!consumeRate()) return socketError(callback, 'Zu viele Nachrichten. Bitte kurz warten.')
    const restriction = await prisma.userRestriction.findUnique({ where: { userId: user.id } }).catch(() => null)
    if (restriction?.bannedAt) return socketError(callback, 'Dein Zugang wurde gesperrt.')
    if (restriction?.mutedUntil && restriction.mutedUntil > new Date()) return socketError(callback, `Du bist bis ${restriction.mutedUntil.toLocaleTimeString('de-DE')} stummgeschaltet.`)
    if (!socket.rooms.has(`room:${roomId}`)) return socketError(callback, 'Du bist diesem Raum nicht beigetreten.')
    const saved = await prisma.chatMessage.create({ data: { roomId, senderId: user.id, senderName: user.displayName, content: clean.data }, select: { id: true, senderId: true, senderName: true, content: true, createdAt: true, deletedAt: true } }).catch(() => null)
    if (!saved) return socketError(callback, 'Nachricht konnte nicht gespeichert werden.')
    io.to(`room:${roomId}`).emit('chat:message', saved); if (typeof callback === 'function') callback({ ok: true })
  })
  socket.on('chat:send-dm', async ({ userId, content, csrfToken } = {}, callback) => {
    if (!validSocketCsrf(socket, csrfToken)) return socketError(callback, 'Sitzung abgelaufen. Bitte neu laden.')
    const clean = z.string().trim().min(1).max(1000).safeParse(content)
    if (!clean.success) return socketError(callback, 'Nachrichten dürfen 1–1000 Zeichen enthalten.')
    if (!consumeRate()) return socketError(callback, 'Zu viele Nachrichten. Bitte kurz warten.')
    const [recipient, restriction] = await Promise.all([prisma.user.findUnique({ where: { id: userId }, select: { id: true } }), prisma.userRestriction.findUnique({ where: { userId: user.id } })])
    if (!recipient || recipient.id === user.id) return socketError(callback, 'Nutzer nicht gefunden.')
    if (restriction?.bannedAt) return socketError(callback, 'Dein Zugang wurde gesperrt.')
    if (restriction?.mutedUntil && restriction.mutedUntil > new Date()) return socketError(callback, `Du bist bis ${restriction.mutedUntil.toLocaleTimeString('de-DE')} stummgeschaltet.`)
    const saved = await prisma.chatMessage.create({ data: { senderId: user.id, recipientId: recipient.id, senderName: user.displayName, content: clean.data }, select: { id: true, senderId: true, recipientId: true, senderName: true, content: true, createdAt: true, deletedAt: true } }).catch(() => null)
    if (!saved) return socketError(callback, 'Nachricht konnte nicht gespeichert werden.')
    io.to(`user:${user.id}`).to(`user:${recipient.id}`).emit('chat:dm', { ...saved, recipientId: recipient.id }); if (typeof callback === 'function') callback({ ok: true })
  })
  socket.on('disconnect', () => {
    const entry = presence.get(user.id)
    if (entry) { entry.sockets.delete(socket.id); if (!entry.sockets.size) { presence.delete(user.id); lastActivity.delete(user.id) } broadcastPresence() }
  })
})

async function findOwnedFolder(userId, parentId) {
  if (!parentId) return null
  const folder = await prisma.fileEntry.findFirst({ where: { id: parentId, userId, kind: 'folder', trashedAt: null } })
  return folder
}
async function subtreeIds(userId, rootId) {
  const ids = [rootId]
  let frontier = [rootId]
  while (frontier.length && ids.length < 5000) {
    const children = await prisma.fileEntry.findMany({ where: { userId, parentId: { in: frontier } }, select: { id: true } })
    frontier = children.map(item => item.id).filter(id => !ids.includes(id))
    ids.push(...frontier)
  }
  return ids
}
async function isDescendant(userId, targetParentId, itemId) {
  let parentId = targetParentId
  let depth = 0
  while (parentId && depth++ < 100) {
    if (parentId === itemId) return true
    const parent = await prisma.fileEntry.findFirst({ where: { id: parentId, userId }, select: { parentId: true } })
    parentId = parent?.parentId || null
  }
  return depth >= 100
}
const fileSelect = { id: true, name: true, kind: true, parentId: true, trashedAt: true, updatedAt: true }

app.get('/api/files', requireLogin, async (req, res, next) => {
  try {
    const userId = req.session.userId
    if (req.query.trash === 'true') {
      const trashed = await prisma.fileEntry.findMany({ where: { userId, trashedAt: { not: null } }, orderBy: { updatedAt: 'desc' }, select: fileSelect })
      const trashedIds = new Set(trashed.map(item => item.id))
      return res.json({ items: trashed.filter(item => !item.parentId || !trashedIds.has(item.parentId)) })
    }
    const type = req.query.type === 'text' ? 'text' : undefined
    const all = req.query.all === 'true'
    const folderId = typeof req.query.folder === 'string' && req.query.folder ? req.query.folder : null
    if (folderId && !(await findOwnedFolder(userId, folderId))) return res.status(404).json({ error: 'Ordner nicht gefunden.' })
    const where = { userId, trashedAt: null, ...(all ? {} : { parentId: folderId }), ...(type ? { kind: type } : {}) }
    res.set('Cache-Control', 'no-store')
    res.json({ items: await prisma.fileEntry.findMany({ where, orderBy: [{ kind: 'asc' }, { name: 'asc' }], select: fileSelect }) })
  } catch (error) { next(error) }
})

app.get('/api/files/:id', requireLogin, async (req, res, next) => {
  try {
    const item = await prisma.fileEntry.findFirst({ where: { id: req.params.id, userId: req.session.userId, trashedAt: null }, select: { ...fileSelect, content: true } })
    if (!item) return res.status(404).json({ error: 'Datei nicht gefunden.' })
    res.json({ item })
  } catch (error) { next(error) }
})

app.post('/api/files', sameOrigin, requireCsrf, requireLogin, async (req, res, next) => {
  try {
    const parsed = z.object({ name: fileNameSchema, kind: fileKindSchema, content: z.string().max(2 * 1024 * 1024).optional(), parentId: z.string().cuid().nullable().optional() }).safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Ungültige Dateidaten.' })
    const data = parsed.data
    if (data.kind === 'folder' && data.content) return res.status(400).json({ error: 'Ordner können keinen Textinhalt haben.' })
    if (data.kind === 'text' && data.content !== undefined && !contentSchema.safeParse(data.content).success) return res.status(400).json({ error: 'Textdateien dürfen höchstens 1 MB groß sein.' })
    if (data.kind === 'image' && (!data.content || !imageContentSchema.safeParse(data.content).success)) return res.status(400).json({ error: 'Das Bildformat oder die Bildgröße ist ungültig.' })
    if (data.parentId && !(await findOwnedFolder(req.session.userId, data.parentId))) return res.status(404).json({ error: 'Zielordner nicht gefunden.' })
    const item = await prisma.fileEntry.create({ data: { userId: req.session.userId, name: data.name, kind: data.kind, content: data.kind === 'text' ? data.content || '' : data.content || null, parentId: data.parentId || null }, select: fileSelect })
    res.status(201).json({ item })
  } catch (error) { next(error) }
})

app.patch('/api/files/:id', sameOrigin, requireCsrf, requireLogin, async (req, res, next) => {
  try {
    const current = await prisma.fileEntry.findFirst({ where: { id: req.params.id, userId: req.session.userId, trashedAt: null } })
    if (!current) return res.status(404).json({ error: 'Datei nicht gefunden.' })
    const parsed = z.object({ name: fileNameSchema.optional(), content: z.string().max(2 * 1024 * 1024).optional(), parentId: z.string().cuid().nullable().optional() }).strict().safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Ungültige Dateidaten.' })
    const data = parsed.data
    if (data.content !== undefined && current.kind === 'text' && !contentSchema.safeParse(data.content).success) return res.status(400).json({ error: 'Textdateien dürfen höchstens 1 MB groß sein.' })
    if (data.content !== undefined && current.kind === 'image' && !imageContentSchema.safeParse(data.content).success) return res.status(400).json({ error: 'Das Bildformat oder die Bildgröße ist ungültig.' })
    if (data.content !== undefined && !['text', 'image'].includes(current.kind)) return res.status(400).json({ error: 'Dieser Dateityp kann nicht bearbeitet werden.' })
    if (Object.prototype.hasOwnProperty.call(data, 'parentId')) {
      if (data.parentId && !(await findOwnedFolder(req.session.userId, data.parentId))) return res.status(404).json({ error: 'Zielordner nicht gefunden.' })
      if (data.parentId && current.kind === 'folder' && await isDescendant(req.session.userId, data.parentId, current.id)) return res.status(400).json({ error: 'Ein Ordner kann nicht in sich selbst verschoben werden.' })
    }
    const item = await prisma.fileEntry.update({ where: { id: current.id }, data, select: fileSelect })
    res.json({ item })
  } catch (error) { next(error) }
})

app.delete('/api/files/:id', sameOrigin, requireCsrf, requireLogin, async (req, res, next) => {
  try {
    const item = await prisma.fileEntry.findFirst({ where: { id: req.params.id, userId: req.session.userId, trashedAt: null }, select: { id: true } })
    if (!item) return res.status(404).json({ error: 'Datei nicht gefunden.' })
    const ids = await subtreeIds(req.session.userId, item.id)
    await prisma.fileEntry.updateMany({ where: { userId: req.session.userId, id: { in: ids } }, data: { trashedAt: new Date() } })
    res.status(204).end()
  } catch (error) { next(error) }
})

app.post('/api/files/:id/restore', sameOrigin, requireCsrf, requireLogin, async (req, res, next) => {
  try {
    const item = await prisma.fileEntry.findFirst({ where: { id: req.params.id, userId: req.session.userId, trashedAt: { not: null } }, select: { id: true } })
    if (!item) return res.status(404).json({ error: 'Element im Papierkorb nicht gefunden.' })
    const ids = await subtreeIds(req.session.userId, item.id)
    await prisma.fileEntry.updateMany({ where: { userId: req.session.userId, id: { in: ids }, trashedAt: { not: null } }, data: { trashedAt: null } })
    res.status(204).end()
  } catch (error) { next(error) }
})

app.delete('/api/files/:id/permanent', sameOrigin, requireCsrf, requireLogin, async (req, res, next) => {
  try {
    const deleted = await prisma.fileEntry.deleteMany({ where: { id: req.params.id, userId: req.session.userId, trashedAt: { not: null } } })
    if (!deleted.count) return res.status(404).json({ error: 'Element im Papierkorb nicht gefunden.' })
    res.status(204).end()
  } catch (error) { next(error) }
})

app.use('/api', (_req, res) => res.status(404).json({ error: 'API-Endpunkt nicht gefunden.' }))
if (isProduction) {
  app.use(express.static(path.join(projectRoot, 'dist'), { maxAge: '1h', index: false }))
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(projectRoot, 'dist', 'index.html')))
}
app.use((error, _req, res, _next) => {
  console.error('OleOS server error:', error instanceof Error ? error.message : 'unknown error')
  res.status(500).json({ error: 'Interner Serverfehler.' })
})

await prisma.$connect()
await initializeDatabase(prisma)
const server = httpServer.listen(port, () => console.info(`OleOS server listening on http://localhost:${port}`))
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(async () => { await prisma.$disconnect(); process.exit(0) }))
}
