import type { NextRequest } from 'next/server'

import { todayIn } from '@/lib/accrual/dates'
import { ForbiddenError, requireReportsAccessOrThrow } from '@/lib/authz'
import { toCsv } from '@/lib/csv'
import { db } from '@/lib/db'
import { orgSettingsOrThrow } from '@/lib/ledger/policies'
import {
  balancesCsv,
  forfeituresCsv,
  leaveDaysCsv,
  leaveSummaryCsv,
  ledgerCsv,
  slug,
} from '@/lib/reports/csv'
import {
  balancesReport,
  employeeLedgerReport,
  forfeitureReport,
  leaveTakenReport,
} from '@/lib/reports/data'
import { dateParam, idParam, paramsOf, rangeParams } from '@/lib/reports/filters'

/**
 * CSV exports of the reports, for administrators and finance. Each takes the
 * same query parameters as its page, read by the same functions, so the
 * file is what the page shows:
 *
 *   ?report=balances&asOf=2026-12-31
 *   ?report=leave&from=…&to=…&type=<id>            a row per employee and type
 *   ?report=leave-days&from=…&to=…&type=<id>       a row per day taken
 *   ?report=forfeitures&from=…&to=…&type=<id>
 *   ?report=ledger&employee=<id>&type=<id>
 *
 * Timesheets have their own export (`/reports/timesheets/export`). A route
 * handler because it returns a file; layouts do not guard route handlers, so
 * this checks access itself (rule 8).
 */
export async function GET(request: NextRequest) {
  try {
    await requireReportsAccessOrThrow()
  } catch (error) {
    if (error instanceof ForbiddenError) return new Response(error.message, { status: 403 })
    throw error
  }

  const params = paramsOf(request.nextUrl)
  const org = await orgSettingsOrThrow()
  const today = todayIn(org.timezone)
  const type = idParam(params, 'type')
  const iso = (date: Date) => date.toISOString().slice(0, 10)

  switch (params.report) {
    case 'balances': {
      const asOf = dateParam(params, 'asOf') ?? today
      const { leaveTypes, rows } = await balancesReport(asOf)
      return csv(balancesCsv(asOf, leaveTypes, rows), `balances-${iso(asOf)}.csv`)
    }
    case 'leave':
    case 'leave-days': {
      const range = rangeParams(params, org, today)
      const { days, summary } = await leaveTakenReport(range, type)
      const name = `leave-taken-${iso(range.from)}-to-${iso(range.to)}`
      return params.report === 'leave'
        ? csv(leaveSummaryCsv(range, summary), `${name}.csv`)
        : csv(leaveDaysCsv(days), `${name}-days.csv`)
    }
    case 'forfeitures': {
      const range = rangeParams(params, org, today)
      const rows = await forfeitureReport(range, type)
      return csv(forfeituresCsv(rows), `forfeitures-${iso(range.from)}-to-${iso(range.to)}.csv`)
    }
    case 'ledger': {
      const employeeId = idParam(params, 'employee')
      const employee = employeeId
        ? await db.employee.findUnique({
            where: { id: employeeId },
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              standardMinutesPerDay: true,
            },
          })
        : null
      if (!employee) return new Response('Unknown employee.', { status: 404 })
      const lines = await employeeLedgerReport(employee.id, type)
      return csv(
        ledgerCsv(employee, lines),
        `${slug('ledger', iso(today), employee.lastName, employee.firstName)}.csv`,
      )
    }
    default:
      return new Response('Unknown report.', { status: 404 })
  }
}

function csv(rows: Parameters<typeof toCsv>[0], name: string) {
  return new Response(toCsv(rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    },
  })
}
