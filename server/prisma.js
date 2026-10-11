import 'dotenv/config'
import { PrismaClient } from './generated/client/index.js'
import { PrismaLibSQL } from '@prisma/adapter-libsql'

const adapter = process.env.TURSO_DATABASE_URL
  ? new PrismaLibSQL({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN })
  : undefined

export const prisma = adapter ? new PrismaClient({ adapter }) : new PrismaClient()
