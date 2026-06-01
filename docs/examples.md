# Examples

## PHP

```json
{
  "lintRunner.vars": {
    "composerBin": "${workspaceFolder}/vendor/bin"
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
    "phpcs": {
      "kind": "diagnostic",
      "command": "${composerBin}/phpcs",
      "args": ["--report=emacs", "${file}"],
      "successExitCodes": [0, 1, 2],
      "parser": {
        "flags": "gm",
        "pattern": "^.+?:(?<line>\\d+):(?<col>\\d+): (?<severity>warning|error) - (?<message>.+)$"
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
        "exclude": ["vendor/**", "runtime/**", "storage/**"]
      },
      "onSave": {
        "strategy": "sequence",
        "tools": ["php-cs-fixer", "phpstan", "phpcs"]
      },
      "manual": {
        "strategy": "parallel",
        "tools": ["phpstan", "phpcs"]
      }
    }
  ]
}
```

## JavaScript / TypeScript

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
