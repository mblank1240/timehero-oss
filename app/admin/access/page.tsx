import Link from 'next/link'

import { AccessRoleFields } from '@/components/access-role-fields'
import { ActionButton, ConfigForm, SubmitButton } from '@/components/form'
import { deleteAccessRole, saveAccessRole } from '@/lib/access/actions'
import { requirePermission } from '@/lib/authz'
import { db } from '@/lib/db'
import { effectivePermissions, PERMISSION_INFO, PERMISSIONS } from '@/lib/permissions'

export const metadata = { title: 'Access · TimeHero' }

export default async function AccessPage() {
  await requirePermission('MANAGE_ACCESS')
  const roles = await db.accessRole.findMany({
    orderBy: [{ allPermissions: 'desc' }, { name: 'asc' }],
    include: {
      employees: {
        where: { isActive: true },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        select: { id: true, firstName: true, lastName: true },
      },
    },
  })

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Access</h1>
        <p className="mt-1 text-sm text-muted">
          What people may do beyond their own records. Every employee can see and act on their own
          time and on what is routed to them as an approver; a role adds to that. Give someone a role
          on their employee record. Nobody can change their own.
        </p>
      </div>

      <ul className="space-y-4">
        {roles.map((role) => {
          const held = effectivePermissions(role)
          return (
            <li key={role.id} className="th-card space-y-3 p-4 text-sm">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="font-semibold">{role.name}</h2>
                  {role.description && <p className="text-muted">{role.description}</p>}
                </div>
                {!role.allPermissions && (
                  <div className="flex shrink-0 gap-2">
                    <Link href={`/admin/access/${role.id}`} className="th-btn-secondary">
                      Edit
                    </Link>
                    {role.employees.length === 0 && (
                      <ActionButton
                        action={deleteAccessRole.bind(null, role.id)}
                        label="Delete"
                        confirmLabel="Confirm delete"
                        variant="danger"
                      />
                    )}
                  </div>
                )}
              </div>
              <p className="text-muted">
                {role.allPermissions
                  ? 'Every permission, including any added later.'
                  : held.length === 0
                    ? 'No permissions.'
                    : held.map((p) => PERMISSION_INFO[p].label).join(' · ')}
              </p>
              <p>
                <span className="text-muted">Held by: </span>
                {role.employees.length === 0
                  ? 'nobody'
                  : role.employees.map((e, i) => (
                      <span key={e.id}>
                        {i > 0 && ', '}
                        <Link href={`/admin/employees/${e.id}`} className="underline">
                          {e.firstName} {e.lastName}
                        </Link>
                      </span>
                    ))}
              </p>
            </li>
          )
        })}
      </ul>

      <section className="space-y-3 border-t border-border pt-8">
        <h2 className="text-lg font-semibold">Add a role</h2>
        <ConfigForm action={saveAccessRole.bind(null, null)}>
          <AccessRoleFields />
          <SubmitButton label="Add role" />
        </ConfigForm>
        <p className="text-xs text-muted">{PERMISSIONS.length} permissions in all.</p>
      </section>
    </div>
  )
}
