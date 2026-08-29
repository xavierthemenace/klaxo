import Link from 'next/link';
import { Button } from '@/components/ui/Button';

const features = [
  {
    eyebrow: '01',
    title: 'Ground the source',
    description:
      'Drop in syllabi, textbooks, lecture notes, PDFs, images, or plain prose. KLAXO preserves the evidence behind what it builds.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
        <path d="m9 15 2 2 4-4" />
      </svg>
    ),
  },
  {
    eyebrow: '02',
    title: 'Engineer the curriculum',
    description:
      'Turn source material into a dependency-aware progression of units, topics, measurable objectives, lessons, practice, and assessments.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6">
        <path d="M4 19.5 9.5 4l3 7 3-7L20.5 19.5" />
        <path d="M4 19.5h16" />
      </svg>
    ),
  },
  {
    eyebrow: '03',
    title: 'Measure mastery',
    description:
      'Practice, assessment, QA, revision, and spaced review work together so a course is designed around understanding rather than coverage.',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <path d="m9 11 3 3L22 4" />
      </svg>
    ),
  },
];

export default function HomePage() {
  return (
    <div className="space-y-16 pb-8">
      <section className="relative overflow-hidden rounded-[2rem] border bg-card shadow-xl">
        <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-br from-primary-50 via-background to-accent-50 dark:from-primary-950/45 dark:via-background dark:to-accent-950/25" />
        <div aria-hidden="true" className="absolute -right-24 -top-28 h-80 w-80 rounded-full bg-primary-300/25 blur-3xl dark:bg-primary-700/20" />
        <div aria-hidden="true" className="absolute -bottom-40 left-1/4 h-80 w-80 rounded-full bg-accent-300/20 blur-3xl dark:bg-accent-700/15" />

        <div className="relative grid gap-10 px-6 py-14 sm:px-10 sm:py-20 lg:grid-cols-[1.15fr_.85fr] lg:items-center lg:px-16">
          <div className="max-w-3xl">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border bg-background/70 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.16em] text-primary shadow-sm backdrop-blur">
              <span className="h-1.5 w-1.5 rounded-full bg-success" />
              AI-powered curriculum engineering
            </div>
            <h1 className="max-w-3xl text-4xl font-bold leading-[1.04] tracking-[-0.035em] sm:text-6xl lg:text-7xl">
              From messy material to a course you can trust.
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
              KLAXO turns your real educational sources into a structured, grounded,
              mastery-oriented curriculum — with provenance, assessment, QA, revision,
              and learner mastery built into the workflow.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link href="/dashboard">
                <Button size="lg" className="w-full sm:w-auto">Build a course</Button>
              </Link>
              <Link href="/dashboard">
                <Button size="lg" variant="outline" className="w-full sm:w-auto">Open dashboard</Button>
              </Link>
            </div>
            <div className="mt-7 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground">
              <span>Source-grounded</span>
              <span>•</span>
              <span>QA + targeted revision</span>
              <span>•</span>
              <span>Mastery tracking</span>
            </div>
          </div>

          <div className="relative mx-auto w-full max-w-md lg:ml-auto">
            <div className="rounded-2xl border bg-card/90 p-4 shadow-lg backdrop-blur">
              <div className="flex items-center justify-between border-b pb-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">KLAXO pipeline</p>
                  <p className="mt-1 font-semibold">Curriculum health</p>
                </div>
                <span className="rounded-full bg-success-subtle px-2.5 py-1 text-xs font-semibold text-success-subtle-foreground">Ready</span>
              </div>
              <div className="space-y-3 py-4">
                {['Sources', 'Blueprint', 'Lessons + practice', 'QA + revision'].map((step, index) => (
                  <div key={step} className="flex items-center gap-3 rounded-xl border bg-background/70 p-3">
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{step}</p>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
                        <div className="h-full w-full rounded-full bg-primary/70" />
                      </div>
                    </div>
                    <span className="text-xs text-success">✓</span>
                  </div>
                ))}
              </div>
              <div className="rounded-xl bg-primary/5 p-3 text-xs leading-5 text-muted-foreground">
                Every stage persists its work so generation can recover without losing the curriculum you already built.
              </div>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div className="max-w-2xl">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-primary">The workflow</p>
          <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">Built around the learning loop.</h2>
          <p className="mt-3 text-muted-foreground">
            KLAXO is not just a text generator. It treats course creation as an engineering pipeline with evidence, structure, validation, and feedback.
          </p>
        </div>
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {features.map((feature) => (
            <div key={feature.title} className="group rounded-2xl border bg-card p-6 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md">
              <div className="flex items-center justify-between">
                <div className="grid h-11 w-11 place-items-center rounded-xl bg-primary/10 text-primary">
                  {feature.icon}
                </div>
                <span className="font-mono text-xs text-muted-foreground">{feature.eyebrow}</span>
              </div>
              <h3 className="mt-6 text-lg font-semibold tracking-tight">{feature.title}</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{feature.description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="relative overflow-hidden rounded-2xl border bg-gradient-to-r from-primary-700 to-primary-600 p-7 text-primary-foreground shadow-lg sm:p-9">
        <div aria-hidden="true" className="absolute -right-16 -top-24 h-64 w-64 rounded-full bg-white/10 blur-3xl" />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary-foreground/70">Start building</p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight">Bring the material. KLAXO builds the system.</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-primary-foreground/75">
              Start from a blank course or your own source material and move from evidence to a learner-ready curriculum.
            </p>
          </div>
          <Link href="/dashboard" className="shrink-0">
            <Button size="lg" variant="secondary" className="bg-white text-primary-950 shadow-sm hover:bg-white/90">
              Start engineering
            </Button>
          </Link>
        </div>
      </section>
    </div>
  );
}
