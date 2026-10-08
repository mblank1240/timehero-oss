/**
 * Reads for the overtime screens. Visibility follows leave requests exactly:
 * the employee, an administrator, or anyone the log has been routed to, and a
 * 404 for everybody else (rule 8).
 */

import type { CurrentUser } from '@/lib/authz'
import { db } from '@/lib/db'
import { currentStep } from '@/lib/requests/chain'

const PERSON = { select: { id: true, firstName: true, lastName: true } } as const

const LIST_SELECT = {
  id: true,
  date: true,
  minutes: true,
  status: true,
  earnedMinutes: true,
  submittedAt: true,
  employee: { select: { id: true, firstName: true, lastName: true, standardMinutesPerDay: true } },
  steps: {
    select: { id: true, step: true, approverId: true, status: true, approver: PERSON },
    orderBy: { step: 'asc' },
  },
} as const

export async function overtimeDetail(id: string) {
  return db.overtimeLog.findUnique({
    where: { id },
    select: {
      id: true,
      date: true,
      minutes: true,
      note: true,
      status: true,
      multiplierBps: true,
      earnedMinutes: true,
      submittedAt: true,
      resolvedAt: true,
      employeeId: true,
      employee: {
        select: { id: true, firstName: true, lastName: true, standardMinutesPerDay: true },
      },
      steps: {
        select: {
          id: true,
          step: true,
          approverId: true,
          status: true,
          decidedAt: true,
          decidedById: true,
          comment: true,
          approver: PERSON,
          decidedBy: PERSON,
        },
        orderBy: { step: 'asc' },
      },
    },
  })
}

type Detail = NonNullable<Awaited<ReturnType<typeof overtimeDetail>>>

export function canViewOvertime(viewer: CurrentUser, log: Detail): boolean {
  if (viewer.role === 'ADMIN') return true
  if (viewer.id === log.employeeId) return true
  return log.steps.some((s) => s.approverId === viewer.id || s.decidedById === viewer.id)
}

export async function overtimeFor(employeeId: string) {
  return db.overtimeLog.findMany({
    where: { employeeId },
    select: LIST_SELECT,
    orderBy: [{ date: 'desc' }, { submittedAt: 'desc' }],
    take: 200,
  })
}

/** Logs whose *current* step is waiting on `viewer`, as `inboxFor` does for requests. */
export async function overtimeInboxFor(viewer: CurrentUser) {
  const candidates = await db.overtimeLog.findMany({
    where: {
      status: 'PENDING',
      employeeId: { not: viewer.id },
      steps: {
        some: {
          status: 'PENDING',
          ...(viewer.role === 'ADMIN'
            ? { OR: [{ approverId: viewer.id }, { approverId: null }] }
            : { approverId: viewer.id }),
        },
      },
    },
    select: LIST_SELECT,
    orderBy: { submittedAt: 'asc' },
  })

  return candidates.filter((log) => {
    const current = currentStep(log.steps)
    if (!current) return false
    return (
      current.approverId === viewer.id || (current.approverId === null && viewer.role === 'ADMIN')
    )
  })
}

/** Every open log, for the administrators' queue. */
export async function pendingOvertime() {
  return db.overtimeLog.findMany({
    where: { status: 'PENDING' },
    select: LIST_SELECT,
    orderBy: { submittedAt: 'asc' },
  })
}

export type OvertimeListItem = Awaited<ReturnType<typeof overtimeFor>>[number]
