import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'KLAXO — Curriculum Engineering',
  description:
    'KLAXO transforms messy educational material into structured, grounded, mastery-oriented courses.',
};

function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span
        aria-hidden="true"
        className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-primary-500 to-primary-700 text-white shadow-sm ring-1 ring-primary-400/20"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4"
        >
          <path d="M4 19.5 9.5 4l3 7 3-7L20.5 19.5" />
        </svg>
      </span>
      <span className="text-[17px] font-semibold tracking-[0.18em]">KLAXO</span>
    </span>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 bg-grid" />
        <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur-xl supports-[backdrop-filter]:bg-background/70">
          <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
            <Link
              href="/dashboard"
              className="rounded-lg text-foreground transition-opacity hover:opacity-80 focus-visible:outline-none"
              aria-label="KLAXO — go to dashboard"
            >
              <Wordmark />
            </Link>

            <nav aria-label="Primary" className="flex items-center gap-1">
              <Link
                href="/"
                className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                Home
              </Link>
              <Link
                href="/dashboard"
                className="rounded-lg bg-primary/10 px-3 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/15"
              >
                Dashboard
              </Link>
            </nav>
          </div>
        </header>
        <main className="relative mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
          {children}
        </main>
      </body>
    </html>
  );
}
