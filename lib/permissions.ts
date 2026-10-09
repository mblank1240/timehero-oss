/**
 * What each permission lets someone do, as plain data and functions — no
 * session, no database — so they can be tested and used from anywhere.
 * `lib/authz.ts` builds its guards on these.
 *
 * Every employee may read and act on their own records, and act on what is
 * routed to them as an approver; none of that needs a permission. A
 * permission is for everything beyond that, and an administrator gives them
 * out in named access roles (`AccessRole`).
 */

import type { Permission } from '@prisma/client'

export type { Permission }

type PermissionInfo = { label: string; description: string }

export const PERMISSION_GROUPS: {
  label: string
  permissions: Partial<Record<Permission, PermissionInfo>>
}[] = [
  {
    label: 'Administration',
    permissions: {
      MANAGE_ACCESS: {
        label: 'Manage access',
        description:
          'Create and edit access roles, and give them to people. Holders can grant any permission, including to others.',
      },
      MANAGE_EMPLOYEES: {
        label: 'Manage employees',
        description:
          'Add, edit and deactivate employees; departments, employee types and approval chains.',
      },
      MANAGE_POLICIES: {
        label: 'Manage leave policies',
        description:
          'Leave types, policies, rollover, pay schedules and holidays. Changes what everyone accrues.',
      },
      MANAGE_DIRECTORY: {
        label: 'Manage directory',
        description:
          'Connect Microsoft 365 and run the directory sync. Shows staff names and addresses.',
      },
      MANAGE_JOBS: {
        label: 'Manage scheduled jobs',
        description: 'See job runs and run a job for a missed date.',
      },
      MANAGE_SETTINGS: {
        label: 'Manage settings',
        description: 'Organization and notification settings.',
      },
    },
  },
  {
    label: 'Time records',
    permissions: {
      VIEW_TIME_RECORDS: {
        label: 'View everyone’s time records',
        description: 'Anyone’s leave requests, overtime, timesheets and balances.',
      },
      MANAGE_TIME_RECORDS: {
        label: 'Act on everyone’s time records',
        description:
          'Approve, deny or reroute on anyone’s behalf; enter and amend leave; fill in and unlock timesheets. Includes viewing them. Never on one’s own.',
      },
      MANAGE_LEDGER: {
        label: 'Ledger adjustments',
        description: 'Read anyone’s ledger and post adjustments to it. Never one’s own.',
      },
    },
  },
  {
    label: 'Reports',
    permissions: {
      REPORT_TIMESHEETS: { label: 'Timesheets report', description: 'Read and export it.' },
      REPORT_BALANCES: { label: 'Balances report', description: 'Read and export it.' },
      REPORT_LEAVE: { label: 'Leave taken report', description: 'Read and export it.' },
      REPORT_FORFEITURES: { label: 'Forfeitures report', description: 'Read and export it.' },
      REPORT_LEDGER: { label: 'Employee ledger report', description: 'Read and export it.' },
    },
  },
]

export const PERMISSIONS = PERMISSION_GROUPS.flatMap(
  (g) => Object.keys(g.permissions) as Permission[],
)

export const PERMISSION_INFO = Object.fromEntries(
  PERMISSION_GROUPS.flatMap((g) => Object.entries(g.permissions)),
) as Record<Permission, PermissionInfo>

/** A permission that brings another with it: acting on a record means seeing it. */
const IMPLIES: Partial<Record<Permission, Permission[]>> = {
  MANAGE_TIME_RECORDS: ['VIEW_TIME_RECORDS'],
}

export type AccessRoleGrant = {
  permissions: readonly Permission[]
  allPermissions: boolean
}

/** Everything a role grants, implications included, in catalogue order. */
export function effectivePermissions(role: AccessRoleGrant | null): Permission[] {
  if (!role) return []
  if (role.allPermissions) return [...PERMISSIONS]
  const held = new Set(role.permissions)
  for (const p of role.permissions) for (const q of IMPLIES[p] ?? []) held.add(q)
  return PERMISSIONS.filter((p) => held.has(p))
}

export type Holder = { permissions: readonly Permission[] }

export function can(user: Holder, permission: Permission): boolean {
  return user.permissions.includes(permission)
}

export function canAny(user: Holder, permissions: readonly Permission[]): boolean {
  return permissions.some((p) => user.permissions.includes(p))
}

/**
 * Whether `actor` may edit `target`'s record: only when the actor holds every
 * permission the target does. Otherwise someone who may manage employees
 * could change an administrator's address to their own and sign in as them.
 */
export function outranksOrEquals(actor: Holder, target: Holder): boolean {
  return target.permissions.every((p) => actor.permissions.includes(p))
}

/** The /admin sections, each behind the permission that opens it. */
export const ADMIN_SECTIONS: { href: string; label: string; permission: Permission }[] = [
  { href: '/admin/employees', label: 'Employees', permission: 'MANAGE_EMPLOYEES' },
  { href: '/admin/requests', label: 'Requests', permission: 'VIEW_TIME_RECORDS' },
  { href: '/admin/departments', label: 'Departments', permission: 'MANAGE_EMPLOYEES' },
  { href: '/admin/pay-schedules', label: 'Pay schedules', permission: 'MANAGE_POLICIES' },
  { href: '/admin/holidays', label: 'Holidays', permission: 'MANAGE_POLICIES' },
  { href: '/admin/leave-types', label: 'Leave types', permission: 'MANAGE_POLICIES' },
  { href: '/admin/leave-policies', label: 'Leave policies', permission: 'MANAGE_POLICIES' },
  { href: '/admin/employee-types', label: 'Employee types', permission: 'MANAGE_EMPLOYEES' },
  { href: '/admin/rollover', label: 'Rollover', permission: 'MANAGE_POLICIES' },
  { href: '/admin/ledger', label: 'Ledger', permission: 'MANAGE_LEDGER' },
  { href: '/admin/directory', label: 'Directory', permission: 'MANAGE_DIRECTORY' },
  { href: '/admin/jobs', label: 'Jobs', permission: 'MANAGE_JOBS' },
  { href: '/admin/notifications', label: 'Notifications', permission: 'MANAGE_SETTINGS' },
  { href: '/admin/settings', label: 'Settings', permission: 'MANAGE_SETTINGS' },
  { href: '/admin/access', label: 'Access', permission: 'MANAGE_ACCESS' },
]

/** The /reports sections, each behind its own permission. */
export const REPORT_SECTIONS: { href: string; label: string; permission: Permission }[] = [
  { href: '/reports/timesheets', label: 'Timesheets', permission: 'REPORT_TIMESHEETS' },
  { href: '/reports/balances', label: 'Balances', permission: 'REPORT_BALANCES' },
  { href: '/reports/leave', label: 'Leave taken', permission: 'REPORT_LEAVE' },
  { href: '/reports/forfeitures', label: 'Forfeitures', permission: 'REPORT_FORFEITURES' },
  { href: '/reports/ledger', label: 'Employee ledger', permission: 'REPORT_LEDGER' },
]

/** The sections of a list this user may open, in order. */
export function sectionsFor<S extends { permission: Permission }>(
  user: Holder,
  sections: readonly S[],
): S[] {
  return sections.filter((s) => can(user, s.permission))
}

/**
 * A database filter for the employees whose access role grants any of
 * `permissions`, directly, through Administrator, or by implication. Plain
 * data, for a Prisma `where`.
 */
export function holdersWhere(permissions: readonly Permission[]) {
  const granting = new Set(permissions)
  for (const [p, implied] of Object.entries(IMPLIES) as [Permission, Permission[]][]) {
    if (implied.some((q) => granting.has(q))) granting.add(p)
  }
  return {
    accessRole: {
      OR: [{ allPermissions: true }, { permissions: { hasSome: [...granting] } }],
    },
  }
}
