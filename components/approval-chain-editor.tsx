'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { setApprovalChain } from '@/lib/employees/actions'

type Candidate = { id: string; firstName: string; lastName: string }

type Props = {
  employeeId: string
  initialApproverIds: string[]
  candidates: Candidate[]
}

export function ApprovalChainEditor({ employeeId, initialApproverIds, candidates }: Props) {
  const router = useRouter()
  const [approverIds, setApproverIds] = useState(initialApproverIds)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const byId = new Map(candidates.map((c) => [c.id, c]))
  const unused = candidates.filter((c) => !approverIds.includes(c.id))

  function mutate(next: string[]) {
    setApproverIds(next)
    setSaved(false)
    setError(null)
  }

  function move(index: number, delta: number) {
    const next = [...approverIds]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    mutate(next)
  }

  function save() {
    startTransition(async () => {
      const result = await setApprovalChain(employeeId, approverIds)
      if (result.ok) {
        setError(null)
        setSaved(true)
        router.refresh()
      } else {
        setError(result.error)
        setSaved(false)
      }
    })
  }

  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="th-error">
          {error}
        </p>
      )}

      {approverIds.length === 0 ? (
        <p className="text-sm text-muted">No approvers. Requests go to all administrators.</p>
      ) : (
        <ol className="space-y-2">
          {approverIds.map((id, index) => {
            const person = byId.get(id)
            return (
              <li
                key={id}
                className="flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2 text-sm"
              >
                <span className="w-16 shrink-0 text-xs uppercase tracking-wide text-muted">
                  Step {index + 1}
                </span>
                <span className="flex-1">
                  {person ? `${person.firstName} ${person.lastName}` : 'Unknown employee'}
                </span>
                <button
                  type="button"
                  onClick={() => move(index, -1)}
                  disabled={index === 0}
                  aria-label={`Move step ${index + 1} earlier`}
                  className="th-btn-secondary px-2 py-1"
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => move(index, 1)}
                  disabled={index === approverIds.length - 1}
                  aria-label={`Move step ${index + 1} later`}
                  className="th-btn-secondary px-2 py-1"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => mutate(approverIds.filter((x) => x !== id))}
                  aria-label={`Remove step ${index + 1}`}
                  className="th-btn-secondary px-2 py-1"
                >
                  Remove
                </button>
              </li>
            )
          })}
        </ol>
      )}

      {unused.length > 0 && (
        <div>
          <label htmlFor="add-approver" className="th-label">
            Add approver
          </label>
          <select
            id="add-approver"
            value=""
            onChange={(e) => {
              if (e.target.value) mutate([...approverIds, e.target.value])
            }}
            className="th-input"
          >
            <option value="">— Select —</option>
            {unused.map((c) => (
              <option key={c.id} value={c.id}>
                {c.firstName} {c.lastName}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button type="button" onClick={save} disabled={pending} className="th-btn">
          {pending ? 'Saving…' : 'Save chain'}
        </button>
        {saved && <span className="text-sm text-muted">Saved.</span>}
      </div>
    </div>
  )
}
