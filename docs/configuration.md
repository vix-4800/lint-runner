# Configuration

Configuration is stored in `settings.json`.

LintRunner 0.4.0 uses tools and pipelines. A tool describes one external command. A target matches files and chooses which tools run for `manual`, `onSave`, or `onOpen`.

Old `linters`, `fixers`, `run`, `preCommands`, target-level `languages`, and `filePatterns` keys are invalid.

## Example

```json
{
  "lintRunner.vars": {
    "composerBin": "${workspaceFolder}/vendor/bin",
    "nodeBin": "${workspaceFolder}/node_modules/.bin"
  },
  "lintRunner.tools": {
    "phpstan": {
      "kind": "diagnostic",
      "command": "${composerBin}/phpstan",
      "args": ["analyse", "--error-format=raw", "${file}"],
      "successExitCodes": [0, 1],
      "parser": {
        "flags": "gm",
        "pattern": "^.+?:(?<line>\\d+):(?<message>.+)$"
      }
    },
    "php-cs-fixer": {
      "kind": "write",
      "command": "${composerBin}/php-cs-fixer",
      "args": ["fix", "${file}"]
    }
  },
  "lintRunner.targets": [
    {
      "name": "PHP",
      "match": {
        "languages": ["php"],
        "files": ["**/*.php"],
        "exclude": ["vendor/**"]
      },
      "onSave": {
        "strategy": "sequence",
        "tools": ["php-cs-fixer", "phpstan"]
      },
      "manual": {
        "strategy": "sequence",
        "tools": ["phpstan"]
      }
    }
  ]
}
```

## Settings

| Setting | Type | Description |
| --- | --- | --- |
| `lintRunner.vars` | `Record<string, string>` | Named template variables. Values can reference built-ins and other vars. Circular references are invalid. |
| `lintRunner.tools` | `Record<string, ToolConfig>` | Tool registry keyed by tool id. |
| `lintRunner.targets` | `TargetConfig[]` | File matching and explicit pipelines. Targets merge by `name` across user, workspace, and folder scopes. |

Existing non-conflicting settings remain: `enabled`, `debounceMs`, `enableLogging`, `enableCodeActions`, `enableCodeLens`, `showManualRunNotifications`, `ignorePatterns`, and `respectGitignore`.

## Tools

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `kind` | `"diagnostic" \| "write"` | yes | `diagnostic` parses command output into Problems. `write` runs commands that can modify files. |
| `command` | `string` | yes | Executable path or command. Supports `~`, built-in variables, and `lintRunner.vars`. |
| `args` | `string[]` | yes | Command args. Supports templates. |
| `cwd` | `string` | no | Defaults to `${workspaceFolder}`. Supports templates. |
| `env` | `Record<string, string>` | no | Process env overrides. Values support templates. |
| `enabled` | `boolean` | no | Defaults to `true`. |
| `timeout` | `number` | no | Defaults to `30000`. |
| `successExitCodes` | `number[]` | no | Defaults to `[0]`. Any other exit code fails the tool. |
| `maxFileSize` | `number` | no | Diagnostic tools skip larger files. |
| `parser` | `RegexParserConfig` | diagnostic only | Required for `diagnostic`; invalid for `write`. |

## Targets

`match.languages`, `match.files`, and `match.exclude` select files. `languages` and `files` are combined with AND. `exclude` always wins.

Pipeline fields are `manual`, `onSave`, and `onOpen`. Every pipeline must be an object:

```json
{
  "strategy": "sequence",
  "tools": ["prettier", "eslint"]
}
```

Array shorthand is invalid. `strategy: "sequence"` runs tools left to right and stops on first failure. `strategy: "parallel"` starts all tools and marks the pipeline failed when any tool fails. `onOpen` also runs on save.

After a successful `write` tool, LintRunner refreshes diagnostics from diagnostic tools in the same pipeline when no later diagnostic tool already ran after that write.

## Regex Parser

The parser config is unchanged. Required named groups: `line`, `message`. Optional groups: `col`, `endLine`, `endCol`, `severity`, `code`.

Unknown output lines are skipped. Invalid regex config blocks runs through config validation.

## Commands

- `LintRunner: Run Pipeline`
- `LintRunner: Run Tool`
- `LintRunner: Inspect Current File`
- `LintRunner: Stop`
- `LintRunner: Clear Diagnostics`
- `LintRunner: Doctor`

## Workspace Trust

Configured commands do not run until the workspace is trusted.
