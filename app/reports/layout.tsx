import Link from 'next/link'

import { requireReportsAccess } from '@/lib/authz'

/**
 * Reports are read by administrators and by finance. Nothing under here
 * changes anything; the export route handlers check access for themselves,
 * since a layout does not guard a route handler.
 */
const SECTIONS = [
  { href: '/reports/timesheets', label: 'Timesheets' },
  { href: '/reports/balances', label: 'Balances' },
  { href: '/reports/leave', label: 'Leave taken' },
  { href: '/reports/forfeitures', label: 'Forfeitures' },
  { href: '/reports/ledger', label: 'Employee ledger' },
]

export default async function ReportsLayout({ children }: LayoutProps<'/reports'>) {
  await requireReportsAccess()

  return (
    <div className="space-y-6">
      <nav aria-label="Reports" className="flex flex-wrap gap-x-4 gap-y-2 border-b border-border pb-3 text-sm">
        {SECTIONS.map((s) => (
          <Link key={s.href} href={s.href} className="text-muted hover:text-foreground">
            {s.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  )
}
