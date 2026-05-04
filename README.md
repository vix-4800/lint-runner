# LintRunner

VS Code extension for running external CLI linters and reporting found issues in Problems.

## Features

- run linters manually via `LintRunner: Run Linters`;
- run auto-fixers manually via `LintRunner: Run Fixers`;
- run linters when a file is opened;
- run linters when a file is saved;
- run auto-fixers when a file is saved;
- clear diagnostics for the active file (or all files) via `LintRunner: Clear Diagnostics`;
- match targets by VS Code language id, with optional glob-based narrowing;
- select linters by file glob patterns;
- substitute command variables in commands and arguments;
- support `~` in command and argument paths;
- resolve commands through the user's login shell `PATH`;
- pre-commands before the main linter;
- hide diagnostic rule codes in Problems;
- status bar with active linter names;
- block command execution in untrusted workspaces.

## Configuration

Configuration is stored in `settings.json`:

Real-world target examples: [docs/examples.md](docs/examples.md).

## Target Config

`lintRunner.targets` groups a shared file set and commands that should run for those files. The setting is resource-scoped:
user, workspace, and folder values are merged by target `name`. If a lower-scope target has the same `name`, only the
fields you specify there are replaced; omitted fields are inherited from the higher scope. A target must match the
file's VS Code language id via `languages`. `filePatterns` is optional and further narrows the match.

| Field                 | Type                               | Required | Description                                                                                                    |
| --------------------- | ---------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `name`                | `string`                           | yes      | Target name in LintRunner output.                                                                              |
| `languages`           | `string[]`                         | yes      | VS Code language ids this target applies to.                                                                   |
| `filePatterns`        | `string[]`                         | no       | Optional glob patterns that further narrow matching files.                                                     |
| `run`                 | `"onOpen" \| "onSave" \| "manual"` | no       | Default run mode for linters. Defaults to `onSave`. `onOpen` also runs on save.                                |
| `preCommands`         | `CommandConfig[]`                  | no       | Commands executed once before target linters.                                                                  |
| `linters`             | `TargetLinterConfig[]`             | no       | Linter commands for the target.                                                                                |
| `fixers`              | `FixerConfig[]`                    | no       | Auto-fixer commands. By default they run via `LintRunner: Run Fixers`; `run: "onSave"` also runs them on save. |

`filePatterns` use the same path matching rules as before: the extension checks the file name, workspace-relative path,
and full path.

Targets must have unique `name` values within the merged configuration. Linters and fixers inside a target are also
matched by `name`, so names must be unique there as well.

### Target Linter Config

| Field                 | Type                               | Required | Description                                                                                |
| --------------------- | ---------------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `name`                | `string`                           | yes      | Source name in Problems.                                                                   |
| `enabled`             | `boolean`                          | no       | Enables or disables this linter. Defaults to `true`.                                       |
| `command`             | `string`                           | yes      | Linter command. Must be in `PATH` or an absolute path. Supports `~` and command variables. |
| `args`                | `string[]`                         | yes      | Command arguments. Supports `~` and command variables.                                     |
| `parser`              | `RegexParserConfig`                | yes      | Regex parser config.                                                                       |
| `run`                 | `"onOpen" \| "onSave" \| "manual"` | no       | Overrides target `run`. `onOpen` also runs on save.                                        |
| `preCommands`         | `CommandConfig[]`                  | no       | Commands before the main linter.                                                           |
| `maxFileSize`         | `number`                           | no       | Maximum file size in bytes for this linter. Larger files are skipped.                      |

`lintRunner.linters` with the old linter-first format is still supported for compatibility. Legacy entries also use
required `languages`, while `filePatterns` remains optional as an extra filter. Legacy linter entries also support
`maxFileSize`.

When a folder-level target reuses a linter `name`, the linter is merged into the higher-scope one by name. You can
override only `args`, only `run`, only `parser`, or any other linter fields without repeating the rest of the config.

## Pre-Commands

`preCommands` run sequentially before the main linter. If one command exits with a non-zero exit code, the main linter
does not run.

### Command Config

| Field     | Type       | Required | Description                                          |
| --------- | ---------- | -------- | ---------------------------------------------------- |
| `name`    | `string`   | no       | Command name in LintRunner output.                   |
| `command` | `string`   | yes      | Executable file. Supports `~` and command variables. |
| `args`    | `string[]` | yes      | Arguments. Supports `~` and command variables.       |

### Fixer Config

| Field     | Type                   | Required | Description                                                         |
| --------- | ---------------------- | -------- | ------------------------------------------------------------------- |
| `name`    | `string`               | yes      | Fixer name shown in LintRunner output and used as the merge identifier. |
| `enabled` | `boolean`              | no       | Enables or disables this fixer. Defaults to `true`.                 |
| `run`     | `"manual" \| "onSave"` | no       | Defaults to `manual`. `onSave` runs the fixer on save and manually. |

Other fields are the same as `CommandConfig`.

## Command Variables

LintRunner substitutes variables in `command`, `args`, `preCommands[*].command`, `preCommands[*].args`,
`fixers[*].command`, and `fixers[*].args`.

| Variable                     | Value                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `${file}`                    | Full file path.                                                                           |
| `${workspaceFolder}`         | Path to the file's workspace folder. Empty string if the file is outside a workspace.     |
| `${relativeFile}`            | File path relative to the workspace folder. Full path if the file is outside a workspace. |
| `${fileDirname}`             | File directory.                                                                           |
| `${fileBasename}`            | File name with extension.                                                                 |
| `${fileBasenameNoExtension}` | File name without extension.                                                              |
| `${fileExtname}`             | File extension, including the dot.                                                        |

Unknown variables are left unchanged.

## Workspace Trust

LintRunner does not run commands from workspace config until the workspace is trusted. In an untrusted workspace,
`LintRunner: Run Linters`, `LintRunner: Run Fixers`, runs on open, and runs on save are skipped.

## Ignoring Files

### `lintRunner.ignorePatterns`

Glob patterns for files that LintRunner should never lint or fix. The same matching rules apply as for target
`filePatterns` (checked against the file name, workspace-relative path, and full path).

Example values: `vendor/**`, `*.min.js`, `dist/**`.

### `lintRunner.respectGitignore`

When `true`, LintRunner skips any file that `git check-ignore` reports as ignored by `.gitignore`. Requires `git` to be
available on `PATH`. The file's workspace folder is used as the working directory.

## Debounce

`lintRunner.debounceMs` sets a delay (in milliseconds) between a save event and the actual linter/fixer run. This is
useful when VS Code's auto-save is enabled with a very short interval, to avoid spawning a new process on every
keystroke.

The default is `0` (no debounce). When multiple saves arrive within the debounce window, only the last one triggers a
run.

## Fix Commands

`fixers` run via `LintRunner: Run Fixers`. If a fixer command has `run: "onSave"`, it also runs when a
matching file is saved. Commands run sequentially for all matching configs. After fixers finish, the extension runs
linters to update Problems.

## Regex Parser

`parser` is a regex config object. The regex runs globally over selected command output and creates one diagnostic per
match.

| Field             | Type                             | Required | Description                                                       |
| ----------------- | -------------------------------- | -------- | ----------------------------------------------------------------- |
| `pattern`         | `string`                         | yes      | JavaScript regex pattern.                                         |
| `flags`           | `string`                         | no       | JavaScript regex flags. `g` is added automatically.               |
| `output`          | `"stdout" \| "stderr" \| "both"` | no       | Output stream to parse. Defaults to `both`.                       |
| `defaultSeverity` | `"error" \| "warning" \| "info"` | no       | Severity when no `severity` group matched. Defaults to `warning`. |
| `messageFormat`   | `"plain" \| "json"`              | no       | Decode the captured `message` as plain text or JSON.              |

Required named groups:

| Group     | Description          |
| --------- | -------------------- |
| `line`    | 1-based line number. |
| `message` | Diagnostic message.  |

Optional named groups:

| Group      | Description                                           |
| ---------- | ----------------------------------------------------- |
| `col`      | 1-based column number.                                |
| `severity` | `error`, `warning`, `info`, plus aliases like `note`. |
| `code`     | Rule id for the diagnostic.                           |

## Development

```bash
npm install
npm run compile
npm run lint
npm test
```
