import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

import { env } from './env'

// Next.js dev-mode hot reload re-evaluates modules, which would otherwise open
// a new pool on every edit until Postgres refuses connections.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function createClient() {
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL })
  return new PrismaClient({
    adapter,
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })
}

export const db = globalForPrisma.prisma ?? createClient()

if (env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = db
  assertClientMatchesSchema(db)
}

/**
 * A long-running dev server keeps the generated Prisma client it loaded at
 * startup, so adding a model and running a migration leaves that process with
 * a client that has never heard of it. The symptom is
 * `Cannot read properties of undefined (reading 'findMany')` pointing at a
 * page, which says nothing about the actual problem.
 *
 * Comparing the schema's models against the loaded client turns that into one
 * sentence naming the fix. Development only: it reads the schema file, which
 * is not deployed.
 */
function assertClientMatchesSchema(client: PrismaClient) {
  let schema: string
  try {
    schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8')
  } catch {
    // No schema to compare against (an unusual working directory, or a
    // deployed bundle). Nothing useful to assert.
    return
  }

  const declared = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1])
  const missing = declared.filter((model) => {
    const key = model.charAt(0).toLowerCase() + model.slice(1)
    return typeof (client as unknown as Record<string, unknown>)[key] !== 'object'
  })

  if (missing.length === 0) return

  throw new Error(
    [
      'The loaded Prisma client is out of date.',
      `Missing models: ${missing.join(', ')}.`,
      '',
      'The schema has changed since this process started. Restart the dev',
      'server (and run `npm run db:migrate` first if the migration has not',
      'been applied yet).',
    ].join('\n'),
  )
}
