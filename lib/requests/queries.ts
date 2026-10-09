/**
 * Reads for the request screens. Authorization is decided here as data —
 * `canView` — and enforced by the page, which renders a 404 rather than
 * admitting the request exists (rule 8).
 */

import type { CurrentUser } from '@/lib/authz'
import { db } from '@/lib/db'
import { overtimeInboxFor } from '@/lib/overtime/queries'
import { timesheetInboxFor } from '@/lib/timesheets/queries'

import { currentStep } from './chain'
import type { RequestFilters } from './filters'
import { can } from '@/lib/permissions'

const PERSON = { select: { id: true, firstName: true, lastName: true } } as const

const LIST_SELECT = {
  id: true,
  status: true,
  totalMinutes: true,
  submittedAt: true,
  employee: { select: { id: true, firstName: true, lastName: true, standardMinutesPerDay: true } },
  leaveType: { select: { id: true, name: true, colorHex: true } },
  days: { select: { date: true }, orderBy: { date: 'asc' } },
  steps: {
    select: { id: true, step: true, approverId: true, status: true, approver: PERSON },
    orderBy: { step: 'asc' },
  },
} as const

export async function requestDetail(id: string) {
  return db.leaveRequest.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      totalMinutes: true,
      note: true,
      submittedAt: true,
      resolvedAt: true,
      employeeId: true,
      employee: {
        select: { id: true, firstName: true, lastName: true, standardMinutesPerDay: true },
      },
      leaveType: { select: { id: true, name: true, colorHex: true } },
      days: { select: { date: true, minutes: true }, orderBy: { date: 'asc' } },
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

type Detail = NonNullable<Awaited<ReturnType<typeof requestDetail>>>

/** The requester, an administrator, or anyone the request has been routed to. */
export function canView(viewer: CurrentUser, request: Detail): boolean {
  if (can(viewer, 'VIEW_TIME_RECORDS')) return true
  if (viewer.id === request.employeeId) return true
  return request.steps.some((s) => s.approverId === viewer.id || s.decidedById === viewer.id)
}

export async function requestsFor(employeeId: string, filters: RequestFilters = {}) {
  return db.leaveRequest.findMany({
    where: {
      employeeId,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.type ? { leaveTypeId: filters.type } : {}),
    },
    select: LIST_SELECT,
    orderBy: { submittedAt: 'desc' },
    take: 200,
  })
}

/** How many of the employee's requests sit in each status, for the filter tabs. */
export async function requestStatusCounts(
  employeeId: string,
  leaveTypeId?: string,
): Promise<Map<string, number>> {
  const rows = await db.leaveRequest.groupBy({
    by: ['status'],
    where: { employeeId, ...(leaveTypeId ? { leaveTypeId } : {}) },
    _count: { _all: true },
  })
  return new Map(rows.map((row) => [row.status, row._count._all]))
}

/**
 * Approved requests with at least one day on or after `today`, soonest first.
 * A request already under way is still upcoming until its last day passes.
 */
export async function upcomingFor(employeeId: string, today: Date) {
  const requests = await db.leaveRequest.findMany({
    where: { employeeId, status: 'APPROVED', days: { some: { date: { gte: today } } } },
    select: LIST_SELECT,
  })
  const firstDay = (r: RequestListItem) => r.days[0]?.date.getTime() ?? 0
  return requests.sort((a, b) => firstDay(a) - firstDay(b))
}

/**
 * Requests whose *current* step is waiting on `viewer` — not every request
 * they appear in. A step-3 approver hears nothing until steps 1 and 2 are
 * done, and an open step reaches every administrator except the requester.
 */
export async function inboxFor(viewer: CurrentUser) {
  const candidates = await db.leaveRequest.findMany({
    where: {
      status: 'PENDING',
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

  return candidates.filter((request) => {
    const current = currentStep(request.steps)
    if (!current) return false
    return (
      current.approverId === viewer.id || (current.approverId === null && can(viewer, 'MANAGE_TIME_RECORDS'))
    )
  })
}

/** Leave requests, overtime logs and timesheets waiting on `viewer`, for the header badge. */
export async function inboxCount(viewer: CurrentUser): Promise<number> {
  const [requests, overtime, timesheets] = await Promise.all([
    inboxFor(viewer),
    overtimeInboxFor(viewer),
    timesheetInboxFor(viewer),
  ])
  return requests.length + overtime.length + timesheets.length
}

/** Every open request, for the administrators' queue. */
export async function pendingRequests() {
  return db.leaveRequest.findMany({
    where: { status: 'PENDING' },
    select: LIST_SELECT,
    orderBy: { submittedAt: 'asc' },
  })
}

export type RequestListItem = Awaited<ReturnType<typeof requestsFor>>[number]

/** "Dana Whitfield (step 2 of 3)", or who it is waiting on when no one is named. */
export function waitingOn(request: Pick<RequestListItem, 'status' | 'steps'>): string | null {
  if (request.status !== 'PENDING') return null
  const current = currentStep(request.steps)
  if (!current) return null

  const who = current.approver
    ? `${current.approver.firstName} ${current.approver.lastName}`
    : 'Any administrator'
  return `${who} (step ${current.step} of ${request.steps.length})`
}
