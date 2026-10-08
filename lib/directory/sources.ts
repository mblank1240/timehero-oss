/**
 * Where a directory's users come from. One shape for every provider, so the
 * sync and sign-in code do not care which one the organization uses — and
 * tests hand in a fake.
 */

import type { DirectoryUser } from './plan'

export type Directory = {
  listUsers(): Promise<DirectoryUser[]>
  getUser(id: string): Promise<DirectoryUser | null>
  /** The organization's verified domains, re-read at each sync. */
  verifiedDomains(): Promise<string[]>
}

export class DirectoryNotSupportedError extends Error {
  constructor(provider: string) {
    super(`Reading the ${provider} directory is not built yet. See docs/AUTH-PLAN.md.`)
    this.name = 'DirectoryNotSupportedError'
  }
}

export async function directoryFor(connection: {
  provider: 'MICROSOFT' | 'GOOGLE'
  tenantId: string
}): Promise<Directory> {
  if (connection.provider === 'MICROSOFT') {
    const graph = await import('@/lib/microsoft/graph')
    return {
      listUsers: () => graph.listUsers(connection.tenantId),
      getUser: (id) => graph.getUser(connection.tenantId, id),
      verifiedDomains: () => graph.verifiedDomains(connection.tenantId),
    }
  }
  // Google Workspace: the Admin SDK Directory API, through a service account
  // with domain-wide delegation. Planned, not built — docs/AUTH-PLAN.md.
  throw new DirectoryNotSupportedError('Google Workspace')
}
