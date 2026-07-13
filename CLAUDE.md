# CLAUDE.md

Next.js AI chatbot (Vercel template): App Router, AI SDK, Drizzle ORM + Postgres, NextAuth, Tailwind v4.

## Commands

- Package manager: **pnpm** (pinned via `packageManager`, corepack-managed)
- `pnpm check` — lint + format check (Biome via Ultracite)
- `pnpm fix` — auto-fix lint + format issues
- `pnpm typecheck` — TypeScript (`tsc --noEmit`, strict mode)
- `pnpm dev` — dev server (Turbopack)

Run `pnpm check` and `pnpm typecheck` after making changes; both must pass. Prefer `pnpm fix` over hand-formatting.

## Conventions

- Biome is the only linter/formatter — do not add ESLint or Prettier.
- `components/ui`, `components/elements`, `components/ai-elements`, `lib/utils.ts`, and `hooks/use-mobile.ts` are vendored/generated and excluded from linting — avoid editing them.
- Pre-commit hook (husky + lint-staged) auto-fixes staged files with Ultracite.
- DB schema changes go through Drizzle: edit `lib/db/schema.ts`, then `pnpm db:generate` + `pnpm db:migrate`.
