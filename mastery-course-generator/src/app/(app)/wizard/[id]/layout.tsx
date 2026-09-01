import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Building a course' };

export default function WizardLayout({ children }: { children: React.ReactNode }) {
  return children;
}
