import 'dotenv/config'
import { prisma } from './prisma.js'
import { initializeDatabase } from './database.js'

try {
  await initializeDatabase(prisma)
  console.info('OleOS SQLite schema is ready.')
} finally {
  await prisma.$disconnect()
}
