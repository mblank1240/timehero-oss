import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";

import { SignOutButton } from "@/components/sign-out-button";
import { canReadReports, getCurrentUser } from "@/lib/authz";
import { unreadCount } from "@/lib/notifications/queries";
import { inboxCount } from "@/lib/requests/queries";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TimeHero",
  description: "Time and leave management for small organizations.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const user = await getCurrentUser();
  const waiting = user ? await inboxCount(user) : 0;
  const unread = user ? await unreadCount(user.id) : 0;

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <header className="border-b border-border bg-surface">
          <nav className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
            <Link href="/" className="text-base font-semibold">
              TimeHero
            </Link>

            {user && (
              <>
                <Link href="/requests/new" className="text-sm text-muted hover:text-foreground">
                  Request time off
                </Link>
                <Link href="/requests" className="text-sm text-muted hover:text-foreground">
                  My requests
                </Link>
                <Link href="/history" className="text-sm text-muted hover:text-foreground">
                  History
                </Link>
                {user.employmentType === "HOURLY" && (
                  <Link href="/timesheets" className="text-sm text-muted hover:text-foreground">
                    Timesheets
                  </Link>
                )}
                {user.employmentType === "SALARIED_EXEMPT" && (
                  <Link href="/overtime" className="text-sm text-muted hover:text-foreground">
                    Overtime
                  </Link>
                )}
                <Link href="/approvals" className="text-sm text-muted hover:text-foreground">
                  Approvals
                  {waiting > 0 && (
                    <span className="ml-1.5 rounded-full bg-accent px-1.5 py-0.5 text-xs font-medium text-accent-contrast">
                      {waiting}
                    </span>
                  )}
                </Link>
              </>
            )}

            {user && canReadReports(user) && (
              <Link href="/reports" className="text-sm text-muted hover:text-foreground">
                Reports
              </Link>
            )}

            {user?.role === "ADMIN" && (
              <Link
                href="/admin/employees"
                className="text-sm text-muted hover:text-foreground"
              >
                Administration
              </Link>
            )}

            {user && (
              <div className="ml-auto flex items-center gap-3 text-sm">
                <Link
                  href="/notifications"
                  className="text-muted hover:text-foreground"
                  aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
                >
                  Notifications
                  {unread > 0 && (
                    <span className="ml-1.5 rounded-full bg-accent px-1.5 py-0.5 text-xs font-medium text-accent-contrast">
                      {unread}
                    </span>
                  )}
                </Link>
                <span className="text-muted">
                  {user.firstName} {user.lastName}
                </span>
                <SignOutButton />
              </div>
            )}
          </nav>
        </header>

        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
