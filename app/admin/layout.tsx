import Link from 'next/link'
import { redirect } from 'next/navigation'

import { requireUser } from '@/lib/authz'
import { ADMIN_SECTIONS, sectionsFor } from '@/lib/permissions'

/**
 * Every /admin route passes through here, and each page checks its own
 * permission too. Server Actions are guarded independently in the `lib`
 * action modules — a layout check alone would not protect a directly-invoked
 * action.
 */
export default async function AdminLayout({ children }: LayoutProps<'/admin'>) {
  const user = await requireUser()
  const sections = sectionsFor(user, ADMIN_SECTIONS)
  if (sections.length === 0) redirect('/')

  return (
    <div className="space-y-6">
      <nav aria-label="Administration" className="flex flex-wrap gap-x-4 gap-y-2 border-b border-border pb-3 text-sm">
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
