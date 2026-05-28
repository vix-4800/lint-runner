# AGENTS.md

Guidance for coding agents working in this repository.

## Project

- Name: `lint-runner`
- Type: VS Code extension (TypeScript)
- Purpose: Run external CLI linters/fixers and convert output into VS Code diagnostics.

## Stack

- TypeScript with `strict` mode enabled.
- VS Code Extension API.
- ESLint + typescript-eslint.

## Commands

- Install deps: `npm install`
- Build: `npm run compile`
- Watch build: `npm run watch`
- Lint: `npm run lint`
- Test: `npm test`

Run `npm run lint` and `npm run compile` after changes.

## Workflow

- Work in TDD only: write or update test first, then code, then verify.
- All tests must pass before task is done.
- Local test runs by agent must be unit-only. Integration part may fail because of `vscode` environment.
- If full `npm test` results are needed, ask user and let user run or provide output separately.

## Architecture

- `src/extension.ts`
- Extension activation and event wiring.
- Registers commands `lintRunner.run` and `lintRunner.fix`.
- Handles on-open/on-save triggers and workspace trust gate.

- `src/linterRunner.ts`
- Core runtime for selecting targets/linters/fixers.
- Runs pre-commands, linters, fixers, and command templating.
- Handles shell PATH resolution, process execution, timeouts, status bar state.
- Parses outputs via parser modules and normalizes diagnostic ranges.

- `src/parser/*.ts`
- Format-specific parsers.
- Keep parser behavior focused: parse text -> diagnostics only.

- `test/*.test.ts`
- Unit tests for extension behavior and parser behavior.

## Parser Contracts

- Parser must be deterministic and tolerant to malformed output.
- Never throw on unrecognized lines; skip them.
- Use zero-based lines/columns internally.
- Set diagnostic `source` to linter name.
- Set `code` when rule id is available.
- Use `createDiagnostic` from `src/parser/diagnostic.ts`.

## Change Rules

- Prefer minimal, local changes.
- Do not rename public configuration keys in `package.json` without migration notes.
- Use `lintRunner.targets` for configuration.
- Keep workspace trust restrictions intact: no command execution in untrusted workspaces.
- Avoid adding dependencies unless necessary.

## Implementation Notes

- Command templating supports placeholders like `${file}` and `${workspaceFolder}`.
- File pattern matching checks file name, workspace-relative path, and full path.
- `onOpen` linters should also run on save (current behavior).
- Fixers can be target-level (`fixers`).

## Definition of Done

- Code compiles with `npm run compile`.
- Lint passes with `npm run lint`.
- Relevant unit tests pass when behavior was changed.
- Full test suite status is confirmed separately with user when needed.
- No regressions in:
- parser selection and parsing;
- run mode routing (`manual`, `onSave`, `onOpen`);
- workspace trust behavior;
- status bar updates and diagnostic publishing.
