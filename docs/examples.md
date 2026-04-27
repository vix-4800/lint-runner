# Configuration Examples

Each snippet below is a single entry for `lintRunner.targets`.

`languages` must match the document's VS Code language id. Some ids depend on installed extensions or file
associations, so adjust them if your editor reports a different language.

- [Configuration Examples](#configuration-examples)
  - [Shell](#shell)
  - [Dockerfile](#dockerfile)
  - [Markdown](#markdown)
  - [YAML](#yaml)
  - [Ansible](#ansible)
  - [Python](#python)
  - [Dotenv](#dotenv)
  - [INI](#ini)
  - [Lua](#lua)
  - [TOML](#toml)
  - [Go](#go)
  - [Fish](#fish)
  - [JavaScript / TypeScript / Vue](#javascript--typescript--vue)
  - [Styles](#styles)
  - [HTML](#html)
  - [SQL](#sql)
  - [Make](#make)
  - [Nginx](#nginx)
  - [XML](#xml)
  - [JSON](#json)
  - [GitHub Actions](#github-actions)
  - [Blade](#blade)
  - [PHP](#php)


## Shell

```json
{
  "name": "Shell",
  "languages": ["shellscript"],
  "filePatterns": ["*.sh"],
  "fixers": [
    {
      "args": ["-w", "${file}"],
      "command": "shfmt",
      "name": "shfmt"
    }
  ],
  "linters": [
    {
      "args": ["-x", "--format", "gcc", "${file}"],
      "command": "shellcheck",
      "name": "Shell Check",
      "parser": {
        "flags": "gm",
        "pattern": "^.+?:(?<line>\\d+):(?<col>\\d+): (?<severity>\\w+): (?<message>.+?) \\[(?<code>SC\\d+)\\]$"
      }
    }
  ]
}
```


## Dockerfile

```json
{
  "name": "Dockerfile",
  "languages": ["dockerfile"],
  "filePatterns": ["Dockerfile", "Dockerfile.*"],
  "linters": [
    {
      "args": [
        "--no-color",
        "--format",
        "tty",
        "--config",
        "~/.config/hadolint.yaml",
        "${file}"
      ],
      "command": "hadolint",
      "name": "HadoLint",
      "parser": {
        "flags": "gm",
        "output": "stdout",
        "pattern": "^(?:hadolint:)?(?:.+?):(?<line>\\d+):? (?<code>\\S+) (?<severity>\\w+): (?<message>.+)$"
      }
    }
  ]
}
```

## Markdown

```json
{
  "name": "Markdown",
  "languages": ["markdown"],
  "filePatterns": ["*.md"],
  "fixers": [
    {
      "args": ["--config", "~/.config/markdownlint/.markdownlint.jsonc", "--fix", "${file}"],
      "command": "markdownlint",
      "name": "Markdown Lint"
    },
    {
      "args": ["--write", "--config", "~/.prettierrc", "${file}"],
      "command": "prettier",
      "enabled": false,
      "name": "Prettier"
    }
  ],
  "linters": [
    {
      "args": ["--config", "~/.config/markdownlint/.markdownlint.jsonc", "${file}"],
      "command": "markdownlint",
      "name": "Markdown Lint",
      "parser": {
        "flags": "gm",
        "pattern": "^.+?:(?<line>\\d+):(?<col>\\d+) (?<severity>\\w+) (?<code>[A-Z0-9]+)(?:/\\S+)? (?<message>.+)$"
      }
    }
  ]
}
```

## YAML

```json
{
  "name": "YAML",
  "languages": ["yaml"],
  "filePatterns": ["*.yml", "*.yaml"],
  "fixers": [
    {
      "args": ["-conf", "~/.config/yamlfmt/.yamlfmt", "${file}"],
      "command": "yamlfmt",
      "name": "YAML Format",
      "run": "onSave"
    }
  ],
  "linters": [
    {
      "args": ["--format", "parsable", "--config-file", "~/.config/yamllint/config", "${file}"],
      "command": "yamllint",
      "name": "YAML Lint",
      "parser": {
        "flags": "gm",
        "pattern": "^.+?:(?<line>\\d+):(?<col>\\d+): \\[(?<severity>\\w+)\\] (?<message>.+?) \\((?<code>[^)]+)\\)$"
      }
    }
  ]
}
```

## Ansible

```json
{
  "name": "Ansible",
  "languages": ["ansible", "yaml"],
  "filePatterns": [
    "ansible/**/*.yml",
    "roles/**/tasks/*.yml",
    "roles/**/handlers/*.yml",
    "roles/**/meta/*.yml",
    "roles/**/defaults/*.yml",
    "roles/**/vars/*.yml",
    "playbooks/**/*.yml"
  ],
  "linters": [
    {
      "args": ["-c", "~/.ansible-lint", "--nocolor", "${file}"],
      "command": "ansible-lint",
      "name": "Ansible Lint",
      "parser": {
        "defaultSeverity": "warning",
        "flags": "gm",
        "pattern": "^(?<code>[a-z][\\w.\\[\\]-]+): (?<message>.+)\\n.+?:(?<line>\\d+)(?::(?<col>\\d+))?"
      }
    }
  ]
}
```

## Python

```json
{
  "name": "Python",
  "languages": ["python"],
  "filePatterns": ["*.py"],
  "fixers": [
    {
      "args": ["check", "--fix", "--config=~/.config/ruff/pyproject.toml", "${file}"],
      "command": "ruff",
      "name": "Ruff Fix"
    },
    {
      "args": ["format", "--config=~/.config/ruff/pyproject.toml", "${file}"],
      "command": "ruff",
      "name": "Ruff Format"
    }
  ],
  "linters": [
    {
      "args": [
        "check",
        "--config=~/.config/ruff/pyproject.toml",
        "--output-format",
        "github",
        "${file}"
      ],
      "command": "ruff",
      "name": "Ruff",
      "parser": {
        "flags": "gm",
        "pattern": "^::(?<severity>error|warning) title=ruff \\((?<code>[^)]+)\\),file=[^,]+,line=(?<line>\\d+),col=(?<col>\\d+),endLine=\\d+,endColumn=\\d+::(?:[^:]+:\\d+:\\d+: [A-Z]\\d+ )?(?<message>[^\\n%]+)"
      }
    }
  ]
}
```

## Dotenv

```json
{
  "name": "Dotenv",
  "languages": ["dotenv", "shellscript"],
  "filePatterns": [".env", ".env.*"],
  "fixers": [
    {
      "args": ["--plain", "fix", "--no-backup", "${file}"],
      "command": "dotenv-linter",
      "name": "Dotenv Linter"
    }
  ],
  "linters": [
    {
      "args": ["--plain", "check", "--skip-updates", "${file}"],
      "command": "dotenv-linter",
      "name": "Dotenv Linter",
      "parser": {
        "flags": "gm",
        "pattern": "^.+?:(?<line>\\d+) (?<code>[A-Za-z][\\w-]*): (?<message>.+)$"
      }
    }
  ]
}
```

## INI

```json
{
  "name": "INI",
  "languages": ["ini", "properties", "editorconfig"],
  "fixers": [
    {
      "args": ["--write", "${file}"],
      "command": "inifmt",
      "name": "inifmt"
    }
  ]
}
```

## Lua

```json
{
  "name": "Lua",
  "languages": ["lua"],
  "filePatterns": ["*.lua"],
  "fixers": [
    {
      "args": ["--config-path", "~/.config/stylua/stylua.toml", "${file}"],
      "command": "stylua",
      "name": "StyLua"
    }
  ],
  "linters": [
    {
      "args": [
        "--config",
        "~/.config/luacheck/.luacheckrc",
        "--formatter",
        "plain",
        "--codes",
        "${file}"
      ],
      "command": "luacheck",
      "name": "LuaCheck",
      "parser": {
        "flags": "gm",
        "pattern": "^.+?:(?<line>\\d+):(?<col>\\d+): \\((?<code>[A-Z]\\d+)\\) (?<message>.+)$"
      }
    }
  ]
}
```

## TOML

```json
{
  "name": "TOML",
  "languages": ["toml"],
  "filePatterns": ["*.toml"],
  "preCommands": [
    {
      "args": ["check", "--config", "~/.config/taplo/taplo.toml", "${file}"],
      "command": "taplo",
      "name": "Taplo"
    }
  ],
  "fixers": [
    {
      "args": ["fmt", "--config", "~/.config/taplo/taplo.toml", "${file}"],
      "command": "taplo",
      "name": "Taplo"
    }
  ],
  "linters": [
    {
      "args": ["lint", "--config", "~/.config/taplo/taplo.toml", "${file}"],
      "command": "taplo",
      "name": "Taplo",
      "parser": {
        "flags": "g",
        "pattern": "(?<severity>error|warning|info):\\s*(?<message>[^\\n]+)[\\s\\S]*?\\u250c\\u2500\\s+[^:\\n]+:(?<line>\\d+):(?<col>\\d+)"
      }
    }
  ]
}
```

## Go

```json
{
  "name": "Go",
  "languages": ["go"],
  "filePatterns": ["*.go"],
  "fixers": [
    {
      "args": ["-w", "${file}"],
      "command": "gofmt",
      "name": "gofmt"
    }
  ]
}
```

## Fish

```json
{
  "name": "Fish",
  "languages": ["fish"],
  "filePatterns": ["*.fish"],
  "fixers": [
    {
      "args": ["-w", "${file}"],
      "command": "fish_indent",
      "name": "fish_indent"
    }
  ]
}
```

## JavaScript / TypeScript / Vue

```json
{
  "name": "JavaScript/TypeScript/Vue",
  "languages": ["javascript", "typescript", "javascriptreact", "typescriptreact", "vue"],
  "filePatterns": ["*.js", "*.ts", "*.jsx", "*.tsx", "*.vue"],
  "fixers": [
    {
      "args": ["--config", "~/.config/eslint/eslint.config.js", "--fix", "${file}"],
      "command": "eslint",
      "name": "ESLint"
    },
    {
      "args": ["--write", "--config", "~/.prettierrc", "${file}"],
      "command": "prettier",
      "enabled": false,
      "name": "Prettier"
    }
  ],
  "linters": [
    {
      "args": [
        "--config",
        "~/.config/eslint/eslint.config.js",
        "--format",
        "stylish",
        "${file}"
      ],
      "command": "eslint",
      "name": "ESLint",
      "parser": {
        "flags": "gm",
        "pattern": "^\\s*(?<line>\\d+):(?<col>\\d+)\\s+(?<severity>error|warning)\\s+(?<message>.+?)\\s{2,}(?<code>\\S+)\\s*$"
      }
    }
  ]
}
```

## Styles

```json
{
  "name": "Styles",
  "languages": ["css", "scss", "less"],
  "filePatterns": ["*.css", "*.scss", "*.less"],
  "fixers": [
    {
      "args": ["--config", "~/.stylelintrc.json", "--fix", "${file}"],
      "command": "stylelint",
      "name": "Style Lint"
    },
    {
      "args": ["--write", "--config", "~/.prettierrc", "${file}"],
      "command": "prettier",
      "enabled": false,
      "name": "Prettier"
    }
  ],
  "linters": [
    {
      "args": ["--config", "~/.stylelintrc.json", "--formatter", "compact", "${file}"],
      "command": "stylelint",
      "name": "Style Lint",
      "parser": {
        "flags": "gm",
        "pattern": "^.+?: line (?<line>\\d+), col (?<col>\\d+), (?<severity>\\w+) - (?<message>.+?) \\((?<code>[^)]+)\\)$"
      }
    }
  ]
}
```

## HTML

```json
{
  "name": "HTML",
  "languages": ["html"],
  "filePatterns": ["*.html"],
  "fixers": [
    {
      "args": ["--write", "--config", "~/.prettierrc", "${file}"],
      "command": "prettier",
      "name": "Prettier"
    }
  ],
  "linters": [
    {
      "args": [
        "-lc",
        "cd \"$1\" && linthtml --config ~/.linthtmlrc --no-color \"$2\"",
        "linthtml",
        "${fileDirname}",
        "${fileBasename}"
      ],
      "command": "bash",
      "name": "Lint HTML",
      "parser": {
        "flags": "gm",
        "pattern": "^\\s*(?<line>\\d+):(?<col>\\d+)\\s+(?<severity>error|warning)\\s+(?<message>.+?)\\s{2,}(?<code>\\S+)\\s*$"
      }
    },
    {
      "args": ["--config", "~/.htmlhintrc", "--format", "unix", "${file}"],
      "command": "htmlhint",
      "name": "HTML Hint",
      "parser": {
        "flags": "gm",
        "pattern": "^.+?:(?<line>\\d+):(?<col>\\d+): (?<message>.+) \\[(?<severity>[^/\\]]+)/(?<code>[^\\]]+)\\]$"
      }
    }
  ]
}
```

## SQL

```json
{
  "name": "SQL",
  "languages": ["sql"],
  "filePatterns": ["*.sql"],
  "fixers": [
    {
      "args": ["fix", "--config", "~/.sqlfluff", "--dialect", "mysql", "${file}"],
      "command": "sqlfluff",
      "name": "Sql Fluff"
    }
  ],
  "linters": [
    {
      "args": [
        "lint",
        "--config",
        "~/.sqlfluff",
        "--format",
        "github-annotation-native",
        "--dialect",
        "mysql",
        "${file}"
      ],
      "command": "sqlfluff",
      "name": "Sql Fluff",
      "parser": {
        "flags": "gm",
        "pattern": "^::(?<severity>error|warning|notice) title=SQLFluff,file=[^,]+,line=(?<line>\\d+),col=(?<col>\\d+),endLine=\\d+,endColumn=\\d+::(?<code>[A-Z]+\\d+): (?<message>.+?)(?: \\[[^\\]]+\\])?$"
      }
    }
  ]
}
```

## Make

```json
{
  "name": "Make",
  "languages": ["makefile"],
  "filePatterns": ["Makefile", "*.mk"],
  "linters": [
    {
      "args": ["--config=~/.config/checkmake/checkmake.ini", "-o", "json", "${file}"],
      "command": "checkmake",
      "name": "Check Make",
      "parser": {
        "flags": "g",
        "messageFormat": "json",
        "pattern": "\\{\\s*\"rule\":\\s*\"(?<code>[^\"]+)\",\\s*\"violation\":\\s*\"(?<message>(?:\\\\.|[^\"])*)\",\\s*\"file_name\":\\s*\"[^\"]+\",\\s*\"line_number\":\\s*(?<line>\\d+)\\s*\\}"
      }
    }
  ]
}
```

## Nginx

```json
{
  "name": "Nginx",
  "languages": ["nginx", "plaintext"],
  "filePatterns": [
    "nginx.conf",
    "**/nginx/**/*.conf",
    "**/sites-available/*",
    "**/sites-enabled/*"
  ],
  "fixers": [
    {
      "args": ["-s", "4", "-i", "${file}"],
      "command": "nginxbeautifier",
      "name": "Nginx Beautifier",
      "run": "onSave"
    }
  ],
  "linters": [
    {
      "args": [
        "--format",
        "errorformat",
        "--no-color",
        "--config",
        "~/.config/nginx-lint/.nginx-lint.toml",
        "${file}"
      ],
      "command": "nginx-lint",
      "name": "Nginx Lint",
      "parser": {
        "flags": "gm",
        "pattern": "^.+?:(?<line>\\d+):(?<col>\\d+): (?<severity>\\w+)\\[(?<code>[^\\]]+)\\]: (?<message>.+)$"
      }
    }
  ]
}
```

## XML

```json
{
  "name": "XML",
  "languages": ["xml", "xsl"],
  "filePatterns": ["*.xml", "*.xsd", "*.xsl", "*.xslt"],
  "preCommands": [
    {
      "args": ["--nonet", "--noout", "${file}"],
      "command": "xmllint",
      "name": "XML Validate"
    }
  ],
  "linters": [
    {
      "args": ["--nonet", "--noout", "${file}"],
      "command": "xmllint",
      "name": "XML Lint",
      "parser": {
        "flags": "gm",
        "output": "stderr",
        "pattern": "^.+?:(?<line>\\d+): (?:(?:parser )?(?<severity>error|warning)) : (?<message>.+)$"
      }
    }
  ]
}
```

## JSON

```json
{
  "name": "JSON",
  "languages": ["json", "jsonc"],
  "filePatterns": ["*.json", "*.jsonc"],
  "fixers": [
    {
      "args": ["--write", "--config", "~/.prettierrc", "${file}"],
      "command": "prettier",
      "name": "Prettier",
      "run": "onSave"
    }
  ],
  "linters": [
    {
      "args": ["-f", "~/.jsonlintrc", "${file}"],
      "command": "jsonlint",
      "name": "JSON Lint",
      "parser": {
        "defaultSeverity": "error",
        "flags": "gm",
        "pattern": "^(?:.+?:\\s*)?line\\s+(?<line>\\d+),\\s*col\\s+(?<col>\\d+),\\s*(?<message>.+?)(?:\\.)?$"
      }
    }
  ]
}
```

## GitHub Actions

```json
{
  "name": "GitHub Actions",
  "languages": ["github-actions-workflow", "yaml"],
  "filePatterns": [".github/workflows/*.yml", ".github/workflows/*.yaml"],
  "linters": [
    {
      "args": ["${file}"],
      "command": "actionlint",
      "name": "Action Lint",
      "parser": {
        "defaultSeverity": "error",
        "flags": "gm",
        "pattern": "^.+?:(?<line>\\d+):(?<col>\\d+): (?<message>.+?) \\[(?<code>[^\\]]+)\\]$"
      }
    }
  ]
}
```

## Blade

```json
{
  "name": "Blade",
  "languages": ["blade", "php"],
  "filePatterns": ["*.blade.php"],
  "fixers": [
    {
      "args": [
        "--write",
        "--config",
        "~/.config/blade-formatter/.bladeformatterrc.json",
        "${file}"
      ],
      "command": "blade-formatter",
      "name": "Blade Formatter"
    }
  ]
}
```

## PHP

```json
{
  "name": "PHP",
  "languages": ["php"],
  "filePatterns": ["*.php"],
  "preCommands": [
    {
      "args": ["-l", "${file}"],
      "command": "php",
      "name": "PHP Lint"
    }
  ],
  "fixers": [
    {
      "args": ["fix", "--config", "~/.config/php-cs-fixer/php-cs-fixer.php", "${file}"],
      "command": "~/.config/composer/vendor/bin/php-cs-fixer",
      "name": "PHP CS Fixer"
    },
    {
      "args": [
        "process",
        "--config",
        "~/.config/rector/rector.php",
        "--ansi",
        "--no-progress-bar",
        "--clear-cache",
        "--no-diffs",
        "${file}"
      ],
      "command": "~/.config/composer/vendor/bin/rector",
      "name": "Rector",
      "run": "manual"
    },
    {
      "args": ["${file}"],
      "command": "~/.config/composer/vendor/bin/phpcbf",
      "enabled": false,
      "name": "PHP Code Beautifier and Fixer"
    }
  ],
  "linters": [
    {
      "args": [
        "--standard=~/.config/phpcs/phpcs.xml",
        "--report=emacs",
        "--ignore=*/vendor/*",
        "-q",
        "--ignore-annotations",
        "--parallel=8",
        "${file}"
      ],
      "command": "~/.config/composer/vendor/bin/phpcs",
      "name": "PHP CodeSniffer",
      "parser": {
        "flags": "gm",
        "pattern": "^.+?:(?<line>\\d+):(?<col>\\d+): (?<severity>warning|error) - (?<message>.+)$"
      }
    },
    {
      "args": ["${file}", "text", "~/.config/phpmd/phpmd.xml"],
      "command": "~/.config/composer/vendor/bin/phpmd",
      "name": "PHP Mess Detector",
      "parser": {
        "flags": "gm",
        "pattern": "^.+?:(?<line>\\d+)\\s+(?<code>\\S+)\\s+(?<message>.+)$"
      }
    },
    {
      "args": [
        "analyse",
        "--error-format=raw",
        "--no-progress",
        "--memory-limit=2G",
        "--configuration=${workspaceFolder}/phpstan.neon",
        "--autoload-file=${workspaceFolder}/phpstan-bootstrap.php",
        "${file}"
      ],
      "command": "~/.config/composer/vendor/bin/phpstan",
      "name": "PHPStan",
      "parser": {
        "defaultSeverity": "error",
        "flags": "gm",
        "pattern": "^.+?:(?<line>\\d+):(?<message>.+?)(?: \\[identifier=(?<code>[^\\]]+)\\])?$"
      },
      "run": "manual"
    }
  ]
}
```
