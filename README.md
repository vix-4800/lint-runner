# LintRunner

VS Code extension for running external CLI linters and fixers, then publishing found issues as VS Code Problems.

LintRunner is useful when a project already has command-line quality tools and you want them integrated into the editor without writing a custom extension for each tool.

## Features

- run linters manually via `LintRunner: Run Linters`;
- run auto-fixers manually via `LintRunner: Run Fixers`;
- run linters on file open and save;
- run auto-fixers on save;
- show diagnostics in Problems;
- show active tool names in the status bar;
- stop running tools via `LintRunner: Stop Running Tools`;
- inspect configured tools via `LintRunner: Doctor`;
- validate config automatically and via `LintRunner: Validate Config`;
- expose optional Code Actions and CodeLens entries for manual tools;
- block command execution in untrusted workspaces.

## Configuration

Configure targets in `settings.json` with `lintRunner.targets`. A target describes which files match and which external commands should run for them.

```json
{
  "lintRunner.targets": [
    {
      "name": "TypeScript",
      "languages": ["typescript"],
      "linters": [
        {
          "name": "eslint",
          "command": "npx",
          "args": ["eslint", "--format", "unix", "${file}"],
          "parser": {
            "pattern": "^(?<file>.*?):(?<line>\\d+):(?<col>\\d+): (?<message>.*?) \\[(?<severity>Warning|Error)/(?<code>.*?)\\]$"
          }
        }
      ]
    }
  ]
}
```

See [docs/configuration.md](docs/configuration.md) for full configuration reference.

Real-world examples: [docs/examples.md](docs/examples.md).

## Commands

- `LintRunner: Run Linters`
- `LintRunner: Run Fixers`
- `LintRunner: Open Actions Menu`
- `LintRunner: Stop Running Tools`
- `LintRunner: Clear Diagnostics`
- `LintRunner: Validate Config`
- `LintRunner: Doctor`

## Development

```bash
npm install
npm run compile
npm run lint
npm test
```
