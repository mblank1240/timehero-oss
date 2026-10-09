import Link from 'next/link'
import { redirect } from 'next/navigation'

import { requireUser } from '@/lib/authz'
import { REPORT_SECTIONS, sectionsFor } from '@/lib/permissions'

/**
 * Reports are read by whoever holds each report's permission. Nothing under
 * here changes anything; each page checks its own permission, and the export
 * route handlers check for themselves, since a layout does not guard a route
 * handler.
 */
export default async function ReportsLayout({ children }: LayoutProps<'/reports'>) {
  const user = await requireUser()
  const sections = sectionsFor(user, REPORT_SECTIONS)
  if (sections.length === 0) redirect('/')

  return (
    <div className="space-y-6">
      <nav aria-label="Reports" className="flex flex-wrap gap-x-4 gap-y-2 border-b border-border pb-3 text-sm">
        {sections.map((s) => (
          <Link key={s.href} href={s.href} className="text-muted hover:text-foreground">
            {s.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  )
}
