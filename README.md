# LintRunner

VS Code extension for running external CLI linters and reporting found issues in Problems.

## Features

- run linters manually via `LintRunner: Run Linters`;
- run auto-fixers manually via `LintRunner: Run Fixers`;
- run linters when a file is opened;
- run linters when a file is saved;
- run auto-fixers when a file is saved;
- select linters by file glob patterns;
- substitute command variables in commands and arguments;
- support `~` in command and argument paths;
- pre-commands before the main linter;
- hide diagnostic rule codes in Problems;
- status bar with active linter names;
- block command execution in untrusted workspaces.

## Configuration

Configuration is stored in `settings.json`:

```json
{
    "lintRunner.targets": [
        {
            "name": "PHP",
            "filePatterns": ["*.php"],
            "preCommands": [{ "name": "php -l", "command": "php", "args": ["-l", "${file}"] }],
            "linters": [
                {
                    "name": "phpcs",
                    "command": "vendor/bin/phpcs",
                    "args": ["--report=json", "${file}"],
                    "parser": "json",
                    "run": "onSave"
                }
            ],
            "fixers": [{ "name": "phpcbf", "command": "vendor/bin/phpcbf", "args": ["${file}"], "run": "onSave" }]
        }
    ]
}
```

## Target Config

`lintRunner.targets` groups a shared file set and commands that should run for those files.

| Field                 | Type                   | Required | Description                                                                                                         |
| --------------------- | ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `name`                | `string`               | yes      | Target name in LintRunner output.                                                                                   |
| `filePatterns`        | `string[]`             | yes      | File glob patterns. Checked against the file name, workspace-relative path, and full path.                           |
| `run`                 | `"onOpen" \| "onSave" \| "manual"` | no       | Default run mode for linters. Defaults to `onSave`.                                                                 |
| `preCommands`         | `CommandConfig[]`      | no       | Commands executed once before target linters.                                                                       |
| `linters`             | `TargetLinterConfig[]` | no       | Linter commands for the target.                                                                                     |
| `fixers`              | `FixerConfig[]`        | no       | Auto-fixer commands. By default they run via `LintRunner: Run Fixers`; `run: "onSave"` also runs them on save.       |
| `showDiagnosticCodes` | `boolean`              | no       | Default value for target linters.                                                                                   |

### Target Linter Config

| Field                 | Type                   | Required | Description                                                                                          |
| --------------------- | ---------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `name`                | `string`               | yes      | Source name in Problems.                                                                             |
| `command`             | `string`               | yes      | Linter command. Must be in `PATH` or an absolute path. Supports `~` and command variables.            |
| `args`                | `string[]`             | yes      | Command arguments. Supports `~` and command variables.                                                |
| `parser`              | `string`               | yes      | Linter output parser.                                                                                |
| `run`                 | `"onOpen" \| "onSave" \| "manual"` | no       | Overrides target `run`.                                                                              |
| `preCommands`         | `CommandConfig[]`      | no       | Commands before the main linter.                                                                     |
| `fixCommand`          | `FixerConfig`          | no       | Legacy per-linter auto-fixer. Prefer target-level `fixers` for new configs.                           |
| `showDiagnosticCodes` | `boolean`              | no       | Overrides target `showDiagnosticCodes`.                                                              |

`lintRunner.linters` with the old linter-first format is still supported for compatibility.

## Pre-Commands

`preCommands` run sequentially before the main linter. If one command exits with a non-zero exit code,
the main linter does not run.

```json
{
    "name": "PHP",
    "filePatterns": ["*.php"],
    "preCommands": [
        {
            "name": "php -l",
            "command": "php",
            "args": ["-l", "${file}"]
        }
    ],
    "linters": [
        {
            "name": "phpcs",
            "command": "vendor/bin/phpcs",
            "args": ["--report=json", "${file}"],
            "parser": "json",
            "run": "onSave"
        }
    ]
}
```

### Command Config

| Field     | Type       | Required | Description                                      |
| --------- | ---------- | -------- | ------------------------------------------------ |
| `name`    | `string`   | no       | Command name in LintRunner output.               |
| `command` | `string`   | yes      | Executable file. Supports `~` and command variables. |
| `args`    | `string[]` | yes      | Arguments. Supports `~` and command variables.   |

### Fixer Config

| Field | Type                    | Required | Description                                                        |
| ----- | ----------------------- | -------- | ------------------------------------------------------------------ |
| `run` | `"manual" \| "onSave"` | no       | Defaults to `manual`. `onSave` runs the fixer on save and manually. |

Other fields are the same as `CommandConfig`.

## Command Variables

LintRunner substitutes variables in `command`, `args`, `preCommands[*].command`, `preCommands[*].args`,
`fixers[*].command`, `fixers[*].args`, `fixCommand.command`, and `fixCommand.args`.

| Variable                     | Value                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `${file}`                    | Full file path.                                                                  |
| `${workspaceFolder}`         | Path to the file's workspace folder. Empty string if the file is outside a workspace. |
| `${relativeFile}`            | File path relative to the workspace folder. Full path if the file is outside a workspace. |
| `${fileDirname}`             | File directory.                                                                  |
| `${fileBasename}`            | File name with extension.                                                        |
| `${fileBasenameNoExtension}` | File name without extension.                                                     |
| `${fileExtname}`             | File extension, including the dot.                                               |

Unknown variables are left unchanged.

## Workspace Trust

LintRunner does not run commands from workspace config until the workspace is trusted. In an untrusted workspace,
`LintRunner: Run Linters`, `LintRunner: Run Fixers`, runs on open, and runs on save are skipped.

## Fix Commands

`fixCommand` and `fixers` run via `LintRunner: Run Fixers`. If a fixer command has `run: "onSave"`,
it also runs when a matching file is saved. Commands run sequentially for all matching configs.
After fixers finish, the extension runs linters to update Problems.

```json
{
    "name": "PHP",
    "filePatterns": ["*.php"],
    "linters": [
        {
            "name": "phpcs",
            "command": "vendor/bin/phpcs",
            "args": ["--report=json", "${file}"],
            "parser": "json",
            "run": "onSave"
        }
    ],
    "fixers": [{ "name": "phpcbf", "command": "vendor/bin/phpcbf", "args": ["${file}"], "run": "onSave" }]
}
```

## Diagnostic Codes

By default, VS Code shows the rule code:

```text
Expected 1 newline at end of file; 0 found phpcs(PSR2.Files.EndFileNewline.NoneFound)
```

To hide the rule code:

```json
{
    "name": "PHP",
    "filePatterns": ["*.php"],
    "showDiagnosticCodes": false,
    "linters": [
        {
            "name": "phpcs",
            "command": "vendor/bin/phpcs",
            "args": ["--report=json", "${file}"],
            "parser": "json",
            "run": "onSave"
        }
    ]
}
```

Result:

```text
Expected 1 newline at end of file; 0 found phpcs
```

## Parsers

| Parser         | Format                                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `json`         | JSON output with `line`, `column`, `message`, `level`/`severity`/`type`, `code`/`rule`/`ruleId` fields. Also supports phpcs JSON.              |
| `jsonlint`     | `line N, col N, message`.                                                                                                                     |
| `parsable`     | `file:line:column: [level] message`.                                                                                                          |
| `taplo`        | Taplo `check` output.                                                                                                                         |
| `xmllint`      | stderr in `file:line: error: message` or `file:line: warning: message` format.                                                                 |
| `linthtml`     | `line:column error message  rule`.                                                                                                            |
| `ansible-lint` | rule line + location line from standard ansible-lint output.                                                                                  |

## Examples

### PHP

```json
{
    "lintRunner.targets": [
        {
            "name": "PHP",
            "filePatterns": ["*.php"],
            "preCommands": [
                {
                    "name": "php -l",
                    "command": "php",
                    "args": ["-l", "${file}"]
                }
            ],
            "showDiagnosticCodes": false,
            "linters": [
                {
                    "name": "phpcs",
                    "command": "vendor/bin/phpcs",
                    "args": ["--report=json", "${file}"],
                    "parser": "json",
                    "run": "onSave"
                }
            ]
        }
    ]
}
```

### Nginx

```json
{
    "lintRunner.targets": [
        {
            "name": "nginx",
            "filePatterns": ["*.conf", "**/nginx/*.conf"],
            "preCommands": [
                {
                    "name": "nginx -t",
                    "command": "nginx",
                    "args": ["-t"]
                }
            ],
            "run": "manual",
            "linters": [
                {
                    "name": "nginx-lint",
                    "command": "nginx-lint",
                    "args": ["${file}"],
                    "parser": "parsable"
                }
            ]
        }
    ]
}
```

### XML

```json
{
    "lintRunner.targets": [
        {
            "name": "XML",
            "filePatterns": ["*.xml"],
            "linters": [
                {
                    "name": "xmllint",
                    "command": "xmllint",
                    "args": ["--noout", "${file}"],
                    "parser": "xmllint",
                    "run": "onSave"
                }
            ]
        }
    ]
}
```

## Development

```bash
npm install
npm run compile
npm run lint
npm test
```
