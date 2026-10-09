/**
 * Reads for the timesheet screens. Visibility follows leave requests and
 * overtime: the employee, an administrator, or anyone the timesheet has been
 * routed to, and a 404 for everybody else (rule 8).
 */

import type { CurrentUser } from '@/lib/authz'
import { db } from '@/lib/db'
import { currentStep } from '@/lib/requests/chain'
import { can, canAny } from '@/lib/permissions'

const PERSON = { select: { id: true, firstName: true, lastName: true } } as const

const LIST_SELECT = {
  id: true,
  status: true,
  submittedAt: true,
  employee: { select: { id: true, firstName: true, lastName: true } },
  payPeriod: { select: { id: true, startDate: true, endDate: true } },
  steps: {
    select: { id: true, step: true, approverId: true, status: true, approver: PERSON },
    orderBy: { step: 'asc' },
  },
} as const

export async function timesheetSteps(timesheetId: string) {
  return db.approvalStep.findMany({
    where: { timesheetId },
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
  })
}

export function canViewTimesheet(
  viewer: CurrentUser,
  sheet: { employeeId: string },
  steps: readonly { approverId: string | null; decidedById: string | null }[],
): boolean {
  // Finance reads every timesheet for payroll, and can change none of them.
  if (canAny(viewer, ['VIEW_TIME_RECORDS', 'REPORT_TIMESHEETS'])) return true
  if (viewer.id === sheet.employeeId) return true
  return steps.some((s) => s.approverId === viewer.id || s.decidedById === viewer.id)
}

export async function timesheetsFor(employeeId: string) {
  return db.timesheet.findMany({
    where: { employeeId },
    select: LIST_SELECT,
    orderBy: { payPeriod: { startDate: 'desc' } },
    take: 60,
  })
}

/** Timesheets whose *current* step is waiting on `viewer`, as `inboxFor` does for requests. */
export async function timesheetInboxFor(viewer: CurrentUser) {
  const candidates = await db.timesheet.findMany({
    where: {
      status: 'SUBMITTED',
      employeeId: { not: viewer.id },
      steps: {
        some: {
          status: 'PENDING',
          ...(can(viewer, 'MANAGE_TIME_RECORDS')
            ? { OR: [{ approverId: viewer.id }, { approverId: null }] }
            : { approverId: viewer.id }),
        },
      },
    },
    select: LIST_SELECT,
    orderBy: { submittedAt: 'asc' },
  })

  return candidates.filter((sheet) => {
    const current = currentStep(sheet.steps)
    if (!current) return false
    return (
      current.approverId === viewer.id || (current.approverId === null && can(viewer, 'MANAGE_TIME_RECORDS'))
    )
  })
}

export type TimesheetListItem = Awaited<ReturnType<typeof timesheetsFor>>[number]
