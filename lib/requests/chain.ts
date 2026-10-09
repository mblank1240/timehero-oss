/**
 * Approval chains: snapshotting one at submission, and moving through it.
 *
 * Pure. The service layer reads the chain, hands it here, and writes back what
 * this decides — so the rules that are easy to get subtly wrong (who may act,
 * what an empty chain means, what a denial does to the steps after it) are
 * tested without a database.
 */

import { can, type Permission } from '@/lib/permissions'

export type StepStatus = 'PENDING' | 'APPROVED' | 'DENIED' | 'SKIPPED'

/** One row of an employee's configured `ApprovalChainStep` list. */
export type ChainLink = { step: number; approverId: string }

/** A step as it is written at submission. */
export type StepSnapshot = {
  step: number
  /** Null means any administrator may act on it. */
  approverId: string | null
  status: 'PENDING' | 'SKIPPED'
  comment: string | null
}

export const SELF_SKIP_COMMENT = 'Skipped automatically: the approver is the requester.'

/**
 * The chain as it stands now, frozen into steps.
 *
 * - Steps are renumbered 1…n in chain order, so a gap in the configured chain
 *   cannot leave a request waiting on a step that does not exist.
 * - An approver who is the requester is recorded as SKIPPED rather than left
 *   out, so the request's history shows the step existed and why nobody
 *   acted on it.
 * - A chain with nobody left to act — empty, or only the requester — routes to
 *   all administrators as a single step with no named approver. Any one of
 *   them may act, except the requester.
 */
export function snapshotChain(chain: readonly ChainLink[], requesterId: string): StepSnapshot[] {
  const ordered = [...chain].sort((a, b) => a.step - b.step)

  const steps: StepSnapshot[] = ordered.map((link, index) => {
    const self = link.approverId === requesterId
    return {
      step: index + 1,
      approverId: link.approverId,
      status: self ? 'SKIPPED' : 'PENDING',
      comment: self ? SELF_SKIP_COMMENT : null,
    }
  })

  if (!steps.some((s) => s.status === 'PENDING')) {
    steps.push({ step: steps.length + 1, approverId: null, status: 'PENDING', comment: null })
  }

  return steps
}

/** A step as the advance logic reads it. */
export type StepState = {
  id: string
  step: number
  approverId: string | null
  status: StepStatus
}

/** The step waiting for a decision: the lowest-numbered one still pending. */
export function currentStep<T extends StepState>(steps: readonly T[]): T | null {
  return steps.filter((s) => s.status === 'PENDING').sort((a, b) => a.step - b.step)[0] ?? null
}

export type Actor = { id: string; permissions: readonly Permission[] }

/**
 * Whether `actor` may decide `step` as an ordinary approver — without an
 * administrator's override.
 *
 * Nobody decides their own request, whatever the chain says. The snapshot
 * already skips them, and the database refuses it too; this is the check that
 * produces a readable message.
 */
export function mayDecide(step: StepState, actor: Actor, requesterId: string): boolean {
  if (actor.id === requesterId) return false
  if (step.status !== 'PENDING') return false
  if (step.approverId === null) return can(actor, 'MANAGE_TIME_RECORDS')
  return step.approverId === actor.id
}

export type Decision = 'APPROVE' | 'DENY' | 'SKIP'

export type DecisionOutcome = {
  /** The status the current step moves to. */
  decided: { stepId: string; status: 'APPROVED' | 'DENIED' | 'SKIPPED' }
  /**
   * Later steps closed without a decision, because the request was resolved
   * before they were reached. A denial closes every step after it: they are
   * never notified and never shown in anyone's inbox.
   */
  closed: string[]
  /** What happened to the request as a whole. */
  result: 'ADVANCED' | 'APPROVED' | 'DENIED'
  /** The step now waiting, when the request advanced. */
  next: StepState | null
}

/**
 * Applies a decision to the current step. Throws when nothing is pending,
 * which the caller turns into "this request has already been decided" — the
 * case two approvers clicking at once produces.
 *
 * SKIP is an administrator's override and counts as moving on: skipping the
 * last pending step approves the request, because there is nobody left whose
 * approval it is waiting for.
 */
export function applyDecision(steps: readonly StepState[], decision: Decision): DecisionOutcome {
  const current = currentStep(steps)
  if (!current) throw new Error('No step is pending')

  const later = steps
    .filter((s) => s.status === 'PENDING' && s.id !== current.id)
    .sort((a, b) => a.step - b.step)

  if (decision === 'DENY') {
    return {
      decided: { stepId: current.id, status: 'DENIED' },
      closed: later.map((s) => s.id),
      result: 'DENIED',
      next: null,
    }
  }

  const next = later[0] ?? null
  return {
    decided: { stepId: current.id, status: decision === 'APPROVE' ? 'APPROVED' : 'SKIPPED' },
    closed: [],
    result: next ? 'ADVANCED' : 'APPROVED',
    next,
  }
}
