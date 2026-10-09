import type { NextRequest } from 'next/server'

import { ForbiddenError, requirePermissionOrThrow } from '@/lib/authz'
import { toCsv } from '@/lib/csv'
import { gridFor, sheetHead } from '@/lib/timesheets/data'
import {
  employeeCsvName,
  employeeCsvRows,
  periodCsvRows,
  periodReport,
} from '@/lib/timesheets/report'
import { zip } from '@/lib/zip'

/**
 * Timesheet exports, for administrators and finance.
 *
 *   ?timesheet=<id>          one employee's timesheet, a row per day
 *   ?period=<id>             the period summary, a row per employee
 *   ?period=<id>&format=zip  every employee's timesheet plus the summary
 *
 * A route handler rather than a page because it returns a file. Layouts do
 * not guard route handlers, so this checks access itself (rule 8).
 */
export async function GET(request: NextRequest) {
  try {
    await requirePermissionOrThrow('REPORT_TIMESHEETS')
  } catch (error) {
    if (error instanceof ForbiddenError) return new Response(error.message, { status: 403 })
    throw error
  }

  const params = request.nextUrl.searchParams
  const timesheetId = params.get('timesheet')

  if (timesheetId) {
    const sheet = await sheetHead(timesheetId)
    if (!sheet) return new Response('Unknown timesheet.', { status: 404 })
    const rows = employeeCsvRows(sheet, await gridFor(sheet))
    return file(toCsv(rows), employeeCsvName(sheet.employee, sheet.payPeriod.startDate), 'text/csv; charset=utf-8')
  }

  const periodId = params.get('period')
  const report = periodId ? await periodReport(periodId) : null
  if (!report) return new Response('Unknown pay period.', { status: 404 })

  const start = report.period.startDate.toISOString().slice(0, 10)
  const summary = toCsv(periodCsvRows(report.period, report.rows))

  if (params.get('format') !== 'zip') {
    return file(summary, `timesheets-${start}-summary.csv`, 'text/csv; charset=utf-8')
  }

  const files = [{ name: `timesheets-${start}-summary.csv`, content: summary }]
  const taken = new Set<string>()
  for (const row of report.rows) {
    if (!row.timesheetId || !row.grid || !row.status) continue
    let name = employeeCsvName(row.employee, report.period.startDate)
    // Two employees with the same name get distinct files.
    for (let n = 2; taken.has(name); n += 1) name = name.replace(/(-\d+)?\.csv$/, `-${n}.csv`)
    taken.add(name)
    const sheet = { employee: row.employee, payPeriod: report.period, status: row.status }
    files.push({ name, content: toCsv(employeeCsvRows(sheet, row.grid)) })
  }

  return file(zip(files), `timesheets-${start}.zip`, 'application/zip')
}

function file(body: string | Uint8Array, name: string, type: string) {
  return new Response(typeof body === 'string' ? body : Buffer.from(body), {
    headers: {
      'Content-Type': type,
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    },
  })
}
