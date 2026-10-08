import Link from 'next/link'

import { requireAdmin } from '@/lib/authz'

/**
 * Every /admin route passes through here. Server Actions are guarded
 * independently in the `lib` action modules — a layout check alone would not
 * protect a directly-invoked action.
 */
const SECTIONS = [
  { href: '/admin/employees', label: 'Employees' },
  { href: '/admin/requests', label: 'Requests' },
  { href: '/admin/departments', label: 'Departments' },
  { href: '/admin/pay-schedules', label: 'Pay schedules' },
  { href: '/admin/holidays', label: 'Holidays' },
  { href: '/admin/leave-types', label: 'Leave types' },
  { href: '/admin/leave-policies', label: 'Leave policies' },
  { href: '/admin/rollover', label: 'Rollover' },
  { href: '/admin/ledger', label: 'Ledger' },
  { href: '/admin/directory', label: 'Directory' },
  { href: '/admin/jobs', label: 'Jobs' },
  { href: '/admin/notifications', label: 'Notifications' },
  { href: '/admin/settings', label: 'Settings' },
]

export default async function AdminLayout({ children }: LayoutProps<'/admin'>) {
  await requireAdmin()

  return (
    <div className="space-y-6">
      <nav aria-label="Administration" className="flex flex-wrap gap-x-4 gap-y-2 border-b border-border pb-3 text-sm">
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
