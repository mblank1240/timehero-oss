/**
 * Reading and writing ledger rows.
 *
 * The engine in `lib/accrual/` decides what entries should exist; this writes
 * them. Idempotency is not a careful-coding convention here — it is the unique
 * index on `(employeeId, leaveTypeId, kind, periodKey)`, and `skipDuplicates`
 * leaning on it. A job that retries, or runs twice because a workflow was
 * triggered manually during a scheduled run, grants nothing a second time.
 */

import type { Prisma, PrismaClient } from '@prisma/client'

import type { ExistingEntry, ProposedEntry } from '@/lib/accrual/types'
import { db } from '@/lib/db'

type Client = PrismaClient | Prisma.TransactionClient

const ENTRY_SELECT = {
  id: true,
  effectiveDate: true,
  minutes: true,
  kind: true,
  expiresOn: true,
  periodKey: true,
} as const

/**
 * Every entry for one employee and leave type, oldest first.
 *
 * The whole history, not a window: a lot replay has to see the grant that a
 * usage entry drew on however long ago it was written, and at ~100 employees
 * the row count never gets interesting.
 */
export async function entriesFor(
  employeeId: string,
  leaveTypeId: string,
  client: Client = db,
): Promise<ExistingEntry[]> {
  return client.ledgerEntry.findMany({
    where: { employeeId, leaveTypeId },
    select: ENTRY_SELECT,
    orderBy: [{ effectiveDate: 'asc' }, { id: 'asc' }],
  })
}

/** The same, for every leave type at once, grouped by type. */
export async function entriesByLeaveType(
  employeeId: string,
  client: Client = db,
): Promise<Map<string, ExistingEntry[]>> {
  const rows = await client.ledgerEntry.findMany({
    where: { employeeId },
    select: { ...ENTRY_SELECT, leaveTypeId: true },
    orderBy: [{ effectiveDate: 'asc' }, { id: 'asc' }],
  })

  const byType = new Map<string, ExistingEntry[]>()
  for (const { leaveTypeId, ...entry } of rows) {
    const list = byType.get(leaveTypeId)
    if (list) list.push(entry)
    else byType.set(leaveTypeId, [entry])
  }

  return byType
}

/**
 * Writes proposed entries, skipping any whose idempotency key already exists.
 * Returns how many rows were actually created, which is what a `JobRun`
 * records and what tells a second run apart from a first.
 */
export async function writeEntries(
  entries: readonly ProposedEntry[],
  opts: { createdById?: string | null; jobRunId?: string | null } = {},
  client: Client = db,
): Promise<number> {
  if (entries.length === 0) return 0

  const result = await client.ledgerEntry.createMany({
    data: entries.map((entry) => ({
      employeeId: entry.employeeId,
      leaveTypeId: entry.leaveTypeId,
      effectiveDate: entry.effectiveDate,
      minutes: entry.minutes,
      kind: entry.kind,
      expiresOn: entry.expiresOn,
      periodKey: entry.periodKey,
      sourceType: entry.sourceType ?? null,
      sourceId: entry.sourceId ?? null,
      note: entry.note ?? null,
      createdById: opts.createdById ?? null,
      jobRunId: opts.jobRunId ?? null,
    })),
    skipDuplicates: true,
  })

  return result.count
}
