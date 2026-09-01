import type { Metadata } from 'next';

// The page itself is a client component and cannot export metadata, so the tab
// title lives here. Without it every page read "study from your own material".
export const metadata: Metadata = { title: 'Your courses' };

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return children;
}
