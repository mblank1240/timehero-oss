import type { Prisma, PrismaClient } from '@prisma/client'

import { db } from './db'

type Client = PrismaClient | Prisma.TransactionClient

export type AuditInput = {
  actorId: string | null
  action: string
  entityType: string
  entityId: string
  before?: unknown
  after?: unknown
  reason?: string
}

/**
 * Writes an audit row. Pass the transaction client when the audited change is
 * itself transactional, so the log can never survive a rolled-back write.
 */
export async function writeAudit(input: AuditInput, client: Client = db) {
  return client.auditLog.create({
    data: {
      actorId: input.actorId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      before: toJson(input.before),
      after: toJson(input.after),
      reason: input.reason,
    },
  })
}

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

/** Fields that are never worth logging or that would bloat the row. */
const OMIT = new Set(['createdAt', 'updatedAt'])

/** Narrows a before/after pair to just what changed, keeping audit rows small. */
export function diff<T extends Record<string, unknown>>(
  before: T,
  after: T,
): { before: Partial<T>; after: Partial<T> } {
  const b: Partial<T> = {}
  const a: Partial<T> = {}

  for (const key of Object.keys(after) as (keyof T & string)[]) {
    if (OMIT.has(key)) continue
    if (!Object.is(normalize(before[key]), normalize(after[key]))) {
      b[key as keyof T] = before[key]
      a[key as keyof T] = after[key]
    }
  }

  return { before: b, after: a }
}

function normalize(v: unknown) {
  return v instanceof Date ? v.getTime() : v
}
