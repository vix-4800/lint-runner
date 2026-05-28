# LintRunner

[![Version](https://vsmarketplacebadges.dev/version/vix.lint-runner.svg)](https://marketplace.visualstudio.com/items?itemName=vix.lint-runner)
[![Installs](https://vsmarketplacebadges.dev/installs-short/vix.lint-runner.svg)](https://marketplace.visualstudio.com/items?itemName=vix.lint-runner)
[![Rating](https://vsmarketplacebadges.dev/rating-short/vix.lint-runner.svg)](https://marketplace.visualstudio.com/items?itemName=vix.lint-runner)
![License](https://img.shields.io/github/license/vix-4800/lint-runner)

VS Code extension for running external CLI tools as file pipelines and publishing parsed diagnostics as VS Code Problems.

## Features

- define reusable `lintRunner.tools`;
- run explicit `manual`, `onSave`, and `onOpen` pipelines;
- support diagnostic tools and write tools;
- parse diagnostics with regex named groups;
- expose optional Code Actions and CodeLens entries for manual pipelines/tools;
- inspect current file matching;
- validate config and run Doctor;
- block command execution in untrusted workspaces.

## Configuration

```json
{
  "lintRunner.vars": {
    "nodeBin": "${workspaceFolder}/node_modules/.bin"
  },
  "lintRunner.tools": {
    "eslint": {
      "kind": "diagnostic",
      "command": "${nodeBin}/eslint",
      "args": ["--format=stylish", "${file}"],
      "successExitCodes": [0, 1],
      "parser": {
        "flags": "gm",
        "pattern": "^\\s*(?<line>\\d+):(?<col>\\d+)\\s+(?<severity>error|warning)\\s+(?<message>.+?)\\s{2,}(?<code>\\S+)\\s*$"
      }
    },
    "prettier": {
      "kind": "write",
      "command": "${nodeBin}/prettier",
      "args": ["--write", "${file}"]
    }
  },
  "lintRunner.targets": [
    {
      "name": "JavaScript / TypeScript",
      "match": {
        "languages": ["javascript", "typescript", "javascriptreact", "typescriptreact", "vue"],
        "files": ["**/*.{js,ts,jsx,tsx,vue}"],
        "exclude": ["node_modules/**", "dist/**"]
      },
      "onSave": {
        "strategy": "sequence",
        "tools": ["prettier", "eslint"]
      },
      "manual": {
        "strategy": "sequence",
        "tools": ["eslint"]
      }
    }
  ]
}
```

See [docs/configuration.md](docs/configuration.md) for full configuration reference.

## Commands

- `LintRunner: Run Pipeline`
- `LintRunner: Run Tool`
- `LintRunner: Inspect Current File`
- `LintRunner: Stop`
- `LintRunner: Clear Diagnostics`
- `LintRunner: Doctor`

## Development

```bash
npm install
npm run compile
npm run lint
npm test
```
