import Link from 'next/link'
import { notFound } from 'next/navigation'

import { AccessRoleFields } from '@/components/access-role-fields'
import { ConfigForm, SubmitButton } from '@/components/form'
import { saveAccessRole } from '@/lib/access/actions'
import { requirePermission } from '@/lib/authz'
import { db } from '@/lib/db'

export const metadata = { title: 'Edit access role · TimeHero' }

export default async function EditAccessRolePage({ params }: PageProps<'/admin/access/[id]'>) {
  await requirePermission('MANAGE_ACCESS')
  const { id } = await params
  const role = await db.accessRole.findUnique({ where: { id } })
  // Administrator always holds everything; there is nothing to edit.
  if (!role || role.allPermissions) notFound()

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <Link href="/admin/access" className="text-sm text-muted hover:text-foreground">
          ← Access
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">{role.name}</h1>
        <p className="mt-1 text-sm text-muted">
          Changes apply to everyone who holds this role on their next page load.
        </p>
      </div>
      <ConfigForm action={saveAccessRole.bind(null, role.id)}>
        <AccessRoleFields defaults={role} />
        <SubmitButton label="Save role" />
      </ConfigForm>
    </div>
  )
}
