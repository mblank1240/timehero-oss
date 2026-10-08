/**
 * A fingerprint of the database as it stood at one moment, for the restore
 * drill (docs/RUNBOOK.md).
 *
 *   npx tsx --tsconfig tsconfig.json scripts/restore-check.ts --at 2026-12-01T10:00:00Z
 *
 * Run it against production and against a point-in-time restore of
 * production to that same moment. The two outputs must be identical: same
 * rows, same balances, same audit trail. Anything written after `--at` is
 * ignored, so production carrying on in the meantime does not matter.
 *
 * Read-only.
 */

import { parseArgs } from 'node:util'

import { db } from '@/lib/db'

async function main() {
  const { values } = parseArgs({ options: { at: { type: 'string' } } })
  const at = new Date(values.at ?? '')
  if (Number.isNaN(at.getTime())) {
    console.error('Usage: scripts/restore-check.ts --at <ISO timestamp, e.g. 2026-12-01T10:00:00Z>')
    process.exit(2)
  }
  const upTo = { createdAt: { lte: at } }

  const [employees, ledger, byType, audit, lastAudit, runs, requests, timesheets] = await Promise.all([
    db.employee.count({ where: upTo }),
    db.ledgerEntry.aggregate({ where: upTo, _count: true, _sum: { minutes: true } }),
    db.ledgerEntry.groupBy({
      by: ['leaveTypeId'],
      where: upTo,
      _count: true,
      _sum: { minutes: true },
      orderBy: { leaveTypeId: 'asc' },
    }),
    db.auditLog.count({ where: upTo }),
    db.auditLog.findFirst({ where: upTo, orderBy: { createdAt: 'desc' }, select: { id: true, createdAt: true } }),
    db.jobRun.count({ where: { startedAt: { lte: at } } }),
    db.leaveRequest.count({ where: upTo }),
    db.timesheet.count({ where: upTo }),
  ])
  const codes = new Map(
    (await db.leaveType.findMany({ select: { id: true, code: true } })).map((t) => [t.id, t.code]),
  )

  const lines = [
    `as of            ${at.toISOString()}`,
    `employees        ${employees}`,
    `ledger entries   ${ledger._count}  (sum ${ledger._sum.minutes ?? 0} min)`,
    ...byType.map(
      (t) => `  ${(codes.get(t.leaveTypeId) ?? t.leaveTypeId).padEnd(15)}${t._count}  (sum ${t._sum.minutes ?? 0} min)`,
    ),
    `leave requests   ${requests}`,
    `timesheets       ${timesheets}`,
    `job runs         ${runs}`,
    `audit rows       ${audit}`,
    `last audit row   ${lastAudit ? `${lastAudit.id} at ${lastAudit.createdAt.toISOString()}` : '—'}`,
  ]
  console.log(lines.join('\n'))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
