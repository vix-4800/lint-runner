# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.4.3] - 2026-06-13

### Changed

- Made tools from `manual`, `onOpen`, and `onSave` pipelines available as manual tools for untitled buffers.

## [0.4.2] - 2026-06-03

### Added

- Added manual linting support for untitled buffers by running tools against a temporary file and publishing diagnostics back to the open document.

## [0.4.1] - 2026-06-02

### Changed

- Hid manual pipeline entries from Code Actions and CodeLens while keeping manual tool entries visible.
- Shortened manual tool Code Action and CodeLens titles.

## [0.4.0] - 2026-06-01

### Added

- Added `lintRunner.tools` reusable tool registry.
- Added explicit `manual`, `onSave`, and `onOpen` pipelines under `lintRunner.targets`.
- Added diagnostic and write tool kinds.
- Added pipeline strategies: `sequence` and `parallel`.
- Added command templating for tool `command`, `cwd`, `args`, and `env`.
- Added manual commands for running matching pipelines and individual tools.
- Added current-file config inspection command.
- Added Doctor command for configured CLI availability checks.
- Added optional Code Actions and CodeLens entries for manual pipelines and tools.
- Added bundled configuration examples.
- Added short manual-run notification for failures like `exit 1 is not in successExitCodes [0]`.

### Changed

- Reworked configuration around tools and pipelines for 0.4.0.
- Replaced old linter runner runtime with `toolRunner`.
- `onOpen` pipelines also run on save.
- Write tools refresh diagnostics from diagnostic tools in the same pipeline when needed.
- Changed `successExitCodes` to be opt-in. Omitted setting no longer checks command exit code.
- Removed default `[0]` from contributed `successExitCodes` configuration schema.

### Removed

- Removed old `linterRunner` runtime and tests.

[0.4.3]: https://github.com/vix-4800/lint-runner/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/vix-4800/lint-runner/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/vix-4800/lint-runner/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/vix-4800/lint-runner/compare/v0.3.0...v0.4.0
