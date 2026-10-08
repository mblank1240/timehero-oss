import { signOut } from '@/lib/auth'

export function SignOutButton() {
  return (
    <form
      action={async () => {
        'use server'
        await signOut({ redirectTo: '/signin' })
      }}
    >
      <button type="submit" className="text-muted hover:text-foreground">
        Sign out
      </button>
    </form>
  )
}
