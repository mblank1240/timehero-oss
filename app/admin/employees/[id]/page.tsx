import Link from 'next/link'
import { notFound } from 'next/navigation'

import { ApprovalChainEditor } from '@/components/approval-chain-editor'
import { EmployeeForm } from '@/components/employee-form'
import { ActionButton, ConfigForm, Field, SubmitButton } from '@/components/form'
import { requirePermission } from '@/lib/authz'
import {
  assignLeavePolicy,
  removeLeavePolicyAssignment,
  updateLeavePolicyAssignment,
} from '@/lib/config/actions'
import { db } from '@/lib/db'
import { describeSkipped, planTypeAssignments } from '@/lib/employee-types/plan'
import { typePolicies } from '@/lib/employee-types/service'
import { unlinkIdentity, updateEmployee } from '@/lib/employees/actions'
import { can } from '@/lib/permissions'
import { formatLeaveDate } from '@/lib/requests/format'

const PROVIDER_LABEL = { MICROSOFT: 'Microsoft', GOOGLE: 'Google' } as const

export const metadata = { title: 'Edit employee · TimeHero' }

/** DATE columns are UTC-midnight; format them without a timezone shift. */
function toDateInput(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : ''
}

export default async function EditEmployeePage({
  params,
  searchParams,
}: PageProps<'/admin/employees/[id]'>) {
  const admin = await requirePermission('MANAGE_EMPLOYEES')
  const { id } = await params
  const { created } = await searchParams

  const [employee, departments, paySchedules, policies, candidates, employeeTypes, accessRoles] = await Promise.all([
    db.employee.findUnique({
      where: { id },
      include: {
        approvalChain: {
          orderBy: { step: 'asc' },
          select: { approverId: true },
        },
        identities: { orderBy: { createdAt: 'asc' } },
        employeeType: { select: { id: true, name: true } },
        accessRole: { select: { name: true } },
        leavePolicies: {
          orderBy: { effectiveFrom: 'desc' },
          include: {
            leavePolicy: {
              select: { name: true, leaveType: { select: { name: true } } },
            },
          },
        },
      },
    }),
    db.department.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    db.paySchedule.findMany({
      where: { isActive: true },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      select: { id: true, name: true },
    }),
    db.leavePolicy.findMany({
      where: { isActive: true },
      orderBy: [{ leaveType: { sortOrder: 'asc' } }, { name: 'asc' }],
      select: { id: true, name: true, leaveType: { select: { name: true } } },
    }),
    db.employee.findMany({
      where: { isActive: true },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: { id: true, firstName: true, lastName: true },
    }),
    db.employeeType.findMany({
      // The employee's own type stays selectable after it is retired.
      where: { OR: [{ isActive: true }, { employees: { some: { id } } }] },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, employmentType: true },
    }),
    // Offered only to someone who may manage access; for anyone else the
    // form shows the role read-only and does not post it.
    can(admin, 'MANAGE_ACCESS')
      ? db.accessRole.findMany({
          orderBy: [{ allPermissions: 'desc' }, { name: 'asc' }],
          select: { id: true, name: true },
        })
      : undefined,
  ])

  if (!employee) notFound()

  // Their manager as the directory last reported it, for comparing with the
  // chain below; the sync starts an empty chain with them.
  const managerSubject = employee.identities.find((i) => i.directoryManagerSubject)?.directoryManagerSubject
  const directoryManager = managerSubject
    ? await db.identity.findFirst({
        where: { subject: managerSubject },
        select: { employee: { select: { firstName: true, lastName: true } } },
      })
    : null

  // Straight after creation from a type: what it could not assign, worked out
  // again from the type as it stands — the same plan the creation followed.
  const skipped =
    created && employee.employeeType
      ? planTypeAssignments({
          policies: await typePolicies(employee.employeeType.id),
          employmentType: employee.employmentType,
          hireDate: employee.hireDate,
        }).skipped
      : []

  const updateThisEmployee = updateEmployee.bind(null, employee.id)

  return (
    <div className="mx-auto max-w-2xl space-y-10">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold">
            {employee.firstName} {employee.lastName}
          </h1>
          {employee.isActive && employee.id !== admin.id && can(admin, 'MANAGE_TIME_RECORDS') && (
            <Link href={`/admin/employees/${employee.id}/leave`} className="th-btn-secondary">
              Record leave
            </Link>
          )}
        </div>
        {created && (
          <div role="status" className="th-card mt-3 space-y-1 p-3 text-sm">
            <p>
              <span className="font-medium">Employee created.</span>{' '}
              {employee.employeeType
                ? `Their leave policies below come from the ${employee.employeeType.name} type, from their hire date.`
                : 'Assign their leave policies below.'}
            </p>
            {skipped.map((s) => (
              <p key={s.leavePolicyId} className="text-danger">
                {describeSkipped(s)}
              </p>
            ))}
          </div>
        )}
        {employee.needsReview && (
          <p role="status" className="th-card mt-3 border-accent/40 p-3 text-sm">
            <span className="font-medium">Needs review.</span> This person came from the
            organization&apos;s directory, or their directory account has been disabled. Check the
            hire date, employment type and pay schedule, assign their leave policies below, and save
            — saving clears this.
          </p>
        )}
      </div>

      <EmployeeForm
        action={updateThisEmployee}
        departments={departments}
        paySchedules={paySchedules}
        employeeTypes={employeeTypes}
        // Nobody changes their own access, so their own record shows it read-only.
        accessRoles={employee.id === admin.id ? undefined : accessRoles}
        accessRoleName={employee.accessRole?.name ?? null}
        submitLabel="Save changes"
        defaults={{
          email: employee.email,
          firstName: employee.firstName,
          lastName: employee.lastName,
          accessRoleId: employee.accessRoleId ?? '',
          employmentType: employee.employmentType,
          hireDate: toDateInput(employee.hireDate),
          terminationDate: toDateInput(employee.terminationDate),
          departmentId: employee.departmentId ?? '',
          payScheduleId: employee.payScheduleId ?? '',
          employeeTypeId: employee.employeeTypeId ?? '',
          standardMinutesPerDay: employee.standardMinutesPerDay,
          isActive: employee.isActive,
        }}
      />

      <section className="space-y-3 border-t border-border pt-8">
        <div>
          <h2 className="text-lg font-semibold">Leave policies</h2>
          <p className="mt-1 text-sm text-muted">
            What this person accrues. Without a policy for a leave type they accrue none of it.
          </p>
        </div>
        {employee.leavePolicies.length > 0 ? (
          <ul className="th-card divide-y divide-border">
            {employee.leavePolicies.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm"
              >
                <span>
                  {a.leavePolicy.leaveType.name}: {a.leavePolicy.name}
                  <span className="text-muted">
                    {' '}
                    · from {formatLeaveDate(a.effectiveFrom)}
                    {a.effectiveTo && ` to ${formatLeaveDate(a.effectiveTo)}`}
                    {a.annualMinutesOverride !== null &&
                      ` · ${a.annualMinutesOverride} minutes a year`}
                  </span>
                </span>
                <div className="flex items-center gap-2">
                  <details className="text-sm">
                    <summary className="cursor-pointer text-accent">Edit</summary>
                    <ConfigForm
                      action={updateLeavePolicyAssignment.bind(null, a.id)}
                      successMessage="Saved."
                      className="mt-2 grid gap-3 sm:grid-cols-3"
                    >
                      <Field label="From" name="effectiveFrom" id={`from-${a.id}`}>
                        <input
                          id={`from-${a.id}`}
                          name="effectiveFrom"
                          type="date"
                          required
                          defaultValue={toDateInput(a.effectiveFrom)}
                          className="th-input"
                        />
                      </Field>
                      <Field label="To (optional)" name="effectiveTo" id={`to-${a.id}`}>
                        <input
                          id={`to-${a.id}`}
                          name="effectiveTo"
                          type="date"
                          defaultValue={toDateInput(a.effectiveTo)}
                          className="th-input"
                        />
                      </Field>
                      <Field label="Annual minutes override" name="annualMinutesOverride" id={`override-${a.id}`}>
                        <input
                          id={`override-${a.id}`}
                          name="annualMinutesOverride"
                          type="number"
                          min={0}
                          defaultValue={a.annualMinutesOverride ?? ''}
                          className="th-input"
                        />
                      </Field>
                      <div className="sm:col-span-3">
                        <SubmitButton label="Save assignment" pendingLabel="Saving…" />
                      </div>
                    </ConfigForm>
                  </details>
                  <ActionButton
                    action={removeLeavePolicyAssignment.bind(null, a.id)}
                    label="Remove"
                    confirmLabel="Remove assignment"
                    variant="danger"
                  />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No leave policies assigned.</p>
        )}
        <ConfigForm
          action={assignLeavePolicy}
          successMessage="Assigned."
          className="grid gap-4 sm:grid-cols-2"
        >
          <input type="hidden" name="employeeId" value={employee.id} />
          <Field label="Policy" name="leavePolicyId">
            <select id="leavePolicyId" name="leavePolicyId" required className="th-input">
              {policies.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.leaveType.name}: {p.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Effective from" name="effectiveFrom">
            <input
              id="effectiveFrom"
              name="effectiveFrom"
              type="date"
              required
              defaultValue={toDateInput(employee.hireDate)}
              className="th-input"
            />
          </Field>
          <Field label="Annual minutes override (optional)" name="annualMinutesOverride">
            <input
              id="annualMinutesOverride"
              name="annualMinutesOverride"
              type="number"
              min={0}
              className="th-input"
            />
          </Field>
          <div className="flex items-end">
            <SubmitButton label="Assign policy" pendingLabel="Assigning…" />
          </div>
        </ConfigForm>
      </section>

      <section className="space-y-3 border-t border-border pt-8">
        <div>
          <h2 className="text-lg font-semibold">Sign-in</h2>
          <p className="mt-1 text-sm text-muted">
            Microsoft and Google accounts linked to this person. An account links on its first
            sign-in, by email, from the organization&apos;s own tenant or domain. Emailed links go
            to {employee.email}.
          </p>
        </div>
        {employee.identities.length > 0 ? (
          <ul className="th-card divide-y divide-border">
            {employee.identities.map((i) => (
              <li
                key={i.id}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm"
              >
                <span>
                  {PROVIDER_LABEL[i.provider]}
                  <span className="text-muted">
                    {i.email && ` · ${i.email}`}
                    {i.directoryAccountEnabled === false && ' · disabled in the directory'}
                    {i.lastUsedAt
                      ? ` · last used ${formatLeaveDate(i.lastUsedAt)}`
                      : ' · never used'}
                  </span>
                </span>
                <ActionButton
                  action={unlinkIdentity.bind(null, i.id)}
                  label="Unlink"
                  confirmLabel="Unlink account"
                  variant="danger"
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No Microsoft or Google account linked yet.</p>
        )}
      </section>

      <section className="space-y-3 border-t border-border pt-8">
        <div>
          <h2 className="text-lg font-semibold">Approval chain</h2>
          <p className="mt-1 text-sm text-muted">
            Requests go to each approver in order. An empty chain routes to everyone who may act on
            others’ time records.
          </p>
          {managerSubject && (
            <p className="mt-1 text-sm text-muted">
              Manager in the directory:{' '}
              {directoryManager
                ? `${directoryManager.employee.firstName} ${directoryManager.employee.lastName}`
                : 'someone with no employee record here'}
              .
            </p>
          )}
        </div>
        <ApprovalChainEditor
          employeeId={employee.id}
          initialApproverIds={employee.approvalChain.map((s) => s.approverId)}
          candidates={candidates.filter((c) => c.id !== employee.id)}
        />
      </section>
    </div>
  )
}
