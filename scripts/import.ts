/**
 * The one-time import of real employees and their opening balances.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/import.ts \
 *     --employees employees.csv --balances balances.csv --as-of 2026-12-31 [--commit]
 *
 * Without --commit nothing is written: the whole import runs in a transaction
 * that is rolled back, and the report says what would have happened. Run it
 * that way until the report is clean and the figures match the old system,
 * then once more with --commit.
 *
 * Either file may be left out. File formats, and the order to do things in,
 * are in docs/GO-LIVE.md; templates are in scripts/import-templates/.
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'

import { parseCsvRecords } from '@/lib/csv'
import { db } from '@/lib/db'
import { formatDuration } from '@/lib/duration'
import { parseBalanceRows, parseEmployeeRows, type RowError } from '@/lib/import/rows'
import { runImport } from '@/lib/import/service'

async function main() {
  const { values } = parseArgs({
    options: {
      employees: { type: 'string' },
      balances: { type: 'string' },
      'as-of': { type: 'string' },
      commit: { type: 'boolean', default: false },
    },
  })

  if (!values.employees && !values.balances) {
    usage('Give --employees, --balances, or both.')
  }
  if (values.balances && !/^\d{4}-\d{2}-\d{2}$/.test(values['as-of'] ?? '')) {
    usage('Opening balances need --as-of YYYY-MM-DD: the day the balances are correct at the end of.')
  }
  const asOf = new Date(`${values['as-of'] ?? new Date().toISOString().slice(0, 10)}T00:00:00.000Z`)

  const errors: RowError[] = []
  const employees = values.employees
    ? parseEmployeeRows(parseCsvRecords(readFileSync(values.employees, 'utf8')), basename(values.employees))
    : { rows: [], errors: [] }
  const balances = values.balances
    ? parseBalanceRows(parseCsvRecords(readFileSync(values.balances, 'utf8')), basename(values.balances))
    : { rows: [], errors: [] }
  errors.push(...employees.errors, ...balances.errors)

  if (errors.length > 0) {
    printErrors(errors)
    process.exitCode = 1
    return
  }

  const source = [values.employees, values.balances].filter(Boolean).map((f) => basename(f!)).join(' and ')
  const report = await runImport(
    { employees: employees.rows, balances: balances.rows },
    { asOf, commit: values.commit, source },
  )

  if (report.errors.length > 0) {
    printErrors(report.errors)
    console.log('\nNothing was written.')
    process.exitCode = 1
    return
  }

  const hours = (m: number) => formatDuration(m, { unit: 'HOURS', minutesPerDay: 480 })
  console.log(report.committed ? 'IMPORTED' : 'DRY RUN — nothing written. Add --commit to import.')
  console.log('')
  console.log(`Employees created:   ${report.employeesCreated.length}`)
  console.log(`Already present:     ${report.employeesExisting.length}${list(report.employeesExisting)}`)
  console.log(`Departments created: ${report.departmentsCreated.length}${list(report.departmentsCreated)}`)
  console.log(`Approval chains set: ${report.chainsSet}`)
  if (report.balances.length > 0) {
    console.log(`\nOpening balances as of ${asOf.toISOString().slice(0, 10)}:`)
    console.log('  email                               type    opening     = grants    + adjustment')
    for (const b of report.balances) {
      if (b.status === 'already-imported') {
        console.log(`  ${b.email.padEnd(36)}${b.leaveType.padEnd(8)}already imported — left alone`)
        continue
      }
      console.log(
        `  ${b.email.padEnd(36)}${b.leaveType.padEnd(8)}${hours(b.openingMinutes).padEnd(12)}` +
          `= ${hours(b.grantMinutes).padEnd(10)}+ ${hours(b.adjustmentMinutes)}`,
      )
    }
  }
  if (report.missingBalances.length > 0) {
    console.log(
      `\nWARNING: ${report.missingBalances.length} policy holder(s) have no opening balance. The next` +
        `\naccrual run will grant them this year's full allotment, as if new:`,
    )
    for (const m of report.missingBalances) console.log(`  ${m.email.padEnd(36)}${m.leaveType}`)
  }
  if (report.policiesSkipped.length > 0) {
    console.log('\nEmployee type policies not assigned (assign them in the app if they are wanted):')
    for (const s of report.policiesSkipped) console.log(`  ${s.email.padEnd(36)}${s.message}`)
  }
}

function printErrors(errors: RowError[]) {
  console.error(`${errors.length} problem(s):`)
  for (const e of errors) console.error(`  ${e.file}, line ${e.line}: ${e.message}`)
}

function list(items: string[]): string {
  return items.length > 0 ? ` (${items.join(', ')})` : ''
}

function usage(message: string): never {
  console.error(message)
  console.error(
    'Usage: scripts/import.ts [--employees file.csv] [--balances file.csv --as-of YYYY-MM-DD] [--commit]',
  )
  process.exit(2)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
