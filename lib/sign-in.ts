/**
 * Sign-in eligibility, as a pure function so it can be tested without a
 * database or an Entra tenant. `lib/auth.ts` is the only caller.
 */

export type SignInCandidate = {
  isActive: boolean
  terminationDate: Date | null
}

export type SignInDecision =
  | { ok: true }
  | { ok: false; reason: 'inactive' | 'terminated' }

/**
 * A terminated employee is refused from their termination date onward, so
 * someone leaving on the 31st can still use the app through that day.
 */
export function resolveEmployeeForSignIn(
  employee: SignInCandidate,
  now: Date,
): SignInDecision {
  if (!employee.isActive) return { ok: false, reason: 'inactive' }

  if (employee.terminationDate) {
    const today = startOfUtcDay(now)
    const termination = startOfUtcDay(employee.terminationDate)
    if (today > termination) return { ok: false, reason: 'terminated' }
  }

  return { ok: true }
}

/**
 * Termination dates are stored as DATE with no timezone, so comparisons are
 * made at UTC midnight to keep them off-by-one free.
 */
function startOfUtcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}
