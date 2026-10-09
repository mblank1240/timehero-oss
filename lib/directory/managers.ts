/**
 * Approval chains from the directory's manager field, as a pure function.
 *
 * The directory knows who reports to whom; it does not know who should
 * approve leave. So it fills a gap and points out a change, and never
 * rewrites a chain an administrator has set:
 *
 * - **Prefill** an empty chain with the employee's manager as step 1.
 * - **Flag** for review an employee whose directory manager has changed since
 *   the last sync, when their chain does not already start with the new one.
 *   A chain that was never compared (the first sync to read managers) is not
 *   flagged: there is no change to report.
 *
 * Only a manager who is an active employee bound to that directory account
 * counts, and nobody is made their own approver.
 */

export type ManagerBinding = {
  employeeId: string
  isActive: boolean
  /** The manager's directory id now; null when the directory has none. */
  managerSubject: string | null
  /** What the last sync recorded; null when none, or never read. */
  previousManagerSubject: string | null
  /** The employee's configured chain, approver ids in step order. */
  chain: readonly string[]
}

export type ManagerPlan = {
  prefill: { employeeId: string; approverId: string }[]
  flag: string[]
}

export function planManagerChains(
  bindings: readonly ManagerBinding[],
  employeeBySubject: ReadonlyMap<string, { id: string; isActive: boolean }>,
): ManagerPlan {
  const plan: ManagerPlan = { prefill: [], flag: [] }

  for (const b of bindings) {
    if (!b.isActive) continue
    const found = b.managerSubject ? employeeBySubject.get(b.managerSubject) : undefined
    const manager = found && found.isActive && found.id !== b.employeeId ? found : null

    if (b.chain.length === 0) {
      if (manager) plan.prefill.push({ employeeId: b.employeeId, approverId: manager.id })
      continue
    }

    const changed =
      b.previousManagerSubject !== null && b.managerSubject !== b.previousManagerSubject
    if (changed && b.chain[0] !== manager?.id) plan.flag.push(b.employeeId)
  }

  return plan
}
