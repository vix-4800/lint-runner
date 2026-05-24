# Configuration Examples

The snippets below are copied from a real working VS Code setup.

The first block shows top-level `lintRunner.*` settings. Each target block after that is a single entry for `lintRunner.targets`.

`languages` must match the document's VS Code language id. Some ids depend on installed extensions or file associations, so adjust them if your editor reports a different language.

- [Top-level LintRunner settings](#top-level-lintrunner-settings)
  - [GitLeaks](#gitleaks)
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
  - [JavaScript/TypeScript/Vue](#javascripttypescriptvue)
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


## Top-level LintRunner settings

```json
{
  "lintRunner.debounceMs": 300,
  "lintRunner.enableCodeActions": true,
  "lintRunner.enableCodeLens": true,
  "lintRunner.ignorePatterns": [
    "vendor/**",
    "*.min.js",
    "dist/**",
    "node_modules/**",
    "storage/framework/views/**",
    "logs/**",
    "cache/**",
    "runtime/**",
    "venv/**"
  ],
  "lintRunner.respectGitignore": true
}
```


## GitLeaks

```json
{
  "languages": [
    "php"
  ],
  "linters": [
    {
      "args": [
        "dir",
        "--config",
        "~/.gitleaks.toml",
        "--report-format",
        "json",
        "--report-path",
        "-",
        "${file}"
      ],
      "command": "gitleaks",
      "name": "GitLeaks",
      "parser": {
        "defaultSeverity": "error",
        "flags": "gm",
        "messageFormat": "json",
        "output": "stdout",
        "pattern": "\\{\\s*\"RuleID\":\\s*\"(?<code>(?:\\\\.|[^\\\"])*)\",\\s*\"Description\":\\s*\"(?<message>(?:\\\\.|[^\\\"])*)\",\\s*\"StartLine\":\\s*(?<line>\\d+),\\s*\"EndLine\":\\s*\\d+,\\s*\"StartColumn\":\\s*(?<col>\\d+),[\\s\\S]*?\"File\":\\s*\"(?<file>(?:\\\\.|[^\\\"])*)\""
      },
      "run": "onSave"
    }
  ],
  "name": "GitLeaks"
}
```


## Shell

```json
{
  "fixers": [
    {
      "args": [
        "-w",
        "${file}"
      ],
      "command": "shfmt",
      "name": "shfmt"
    }
  ],
  "languages": [
    "shellscript"
  ],
  "linters": [
    {
      "args": [
        "-x",
        "--format",
        "gcc",
        "${file}"
      ],
      "command": "shellcheck",
      "name": "Shell Check",
      "parser": {
        "flags": "gm",
        "pattern": "^.+?:(?<line>\\d+):(?<col>\\d+): (?<severity>\\w+): (?<message>.+?) \\[(?<code>SC\\d+)\\]$"
      }
    }
  ],
  "name": "Shell"
}
```


## Dockerfile

```json
{
  "languages": [
    "dockerfile"
  ],
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
  ],
  "name": "Dockerfile"
}
```


## Markdown

```json
{
  "fixers": [
    {
      "args": [
        "--config",
        "~/.config/markdownlint/.markdownlint.jsonc",
        "--fix",
        "${file}"
      ],
      "command": "markdownlint",
      "name": "Markdown Lint",
      "run": "onSave"
    },
    {
      "args": [
        "--write",
        "--config",
        "~/.prettierrc",
        "${file}"
      ],
      "command": "prettier",
      "enabled": false,
      "name": "Prettier"
    }
  ],
  "languages": [
    "markdown"
  ],
  "linters": [
    {
      "args": [
        "--config",
        "~/.config/markdownlint/.markdownlint.jsonc",
        "${file}"
      ],
      "command": "markdownlint",
      "name": "Markdown Lint",
      "parser": {
        "flags": "gm",
        "pattern": "^.+?:(?<line>\\d+):(?<col>\\d+) (?<severity>\\w+) (?<code>[A-Z0-9]+)(?:/\\S+)? (?<message>.+)$"
      }
    }
  ],
  "name": "Markdown"
}
```


## YAML

```json
{
  "fixers": [
    {
      "args": [
        "-conf",
        "~/.config/yamlfmt/.yamlfmt",
        "${file}"
      ],
      "command": "yamlfmt",
      "name": "YAML Format",
      "run": "onSave"
    }
  ],
  "languages": [
    "yaml",
    "dockercompose"
  ],
  "linters": [
    {
      "args": [
        "--format",
        "parsable",
        "--config-file",
        "~/.config/yamllint/config",
        "${file}"
      ],
      "command": "yamllint",
      "name": "YAML Lint",
      "parser": {
        "flags": "gm",
        "pattern": "^.+?:(?<line>\\d+):(?<col>\\d+): \\[(?<severity>\\w+)\\] (?<message>.+?) \\((?<code>[^)]+)\\)$"
      }
    }
  ],
  "name": "YAML"
}
```


## Ansible

```json
{
  "filePatterns": [
    "ansible/**/*.yml",
    "roles/**/tasks/*.yml",
    "roles/**/handlers/*.yml",
    "roles/**/meta/*.yml",
    "roles/**/defaults/*.yml",
    "roles/**/vars/*.yml",
    "playbooks/**/*.yml"
  ],
  "languages": [
    "ansible",
    "yaml"
  ],
  "linters": [
    {
      "args": [
        "-c",
        "~/.ansible-lint",
        "--nocolor",
        "${file}"
      ],
      "command": "ansible-lint",
      "name": "Ansible Lint",
      "parser": {
        "defaultSeverity": "warning",
        "flags": "gm",
        "pattern": "^(?<code>[a-z][\\w.\\[\\]-]+): (?<message>.+)\\n.+?:(?<line>\\d+)(?::(?<col>\\d+))?"
      }
    }
  ],
  "name": "Ansible"
}
```


## Python

```json
{
  "fixers": [
    {
      "args": [
        "check",
        "--fix",
        "--config=~/.config/ruff/pyproject.toml",
        "${file}"
      ],
      "command": "ruff",
      "name": "Ruff Fix"
    },
    {
      "args": [
        "format",
        "--config=~/.config/ruff/pyproject.toml",
        "${file}"
      ],
      "command": "ruff",
      "name": "Ruff Format"
    }
  ],
  "languages": [
    "python"
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
  ],
  "name": "Python"
}
```


## Dotenv

```json
{
  "filePatterns": [
    ".env",
    ".env.*"
  ],
  "fixers": [
    {
      "args": [
        "--plain",
        "fix",
        "--no-backup",
        "${file}"
      ],
      "command": "dotenv-linter",
      "name": "Dotenv Linter"
    }
  ],
  "languages": [
    "dotenv",
    "shellscript"
  ],
  "linters": [
    {
      "args": [
        "--plain",
        "check",
        "--skip-updates",
        "${file}"
      ],
      "command": "dotenv-linter",
      "name": "Dotenv Linter",
      "parser": {
        "flags": "gm",
        "pattern": "^.+?:(?<line>\\d+) (?<code>[A-Za-z][\\w-]*): (?<message>.+)$"
      }
    }
  ],
  "name": "Dotenv"
}
```


## INI

```json
{
  "fixers": [
    {
      "args": [
        "--write",
        "${file}",
        "--single-space"
      ],
      "command": "inifmt",
      "name": "INI Format",
      "run": "onSave"
    }
  ],
  "languages": [
    "ini",
    "properties",
    "editorconfig"
  ],
  "name": "INI"
}
```


## Lua

```json
{
  "fixers": [
    {
      "args": [
        "--config-path",
        "~/.config/stylua/stylua.toml",
        "${file}"
      ],
      "command": "stylua",
      "name": "StyLua"
    }
  ],
  "languages": [
    "lua"
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
  ],
  "name": "Lua"
}
```


## TOML

```json
{
  "fixers": [
    {
      "args": [
        "format",
        "--config",
        "~/.config/taplo/taplo.toml",
        "${file}"
      ],
      "command": "taplo",
      "name": "Taplo",
      "run": "onSave"
    }
  ],
  "languages": [
    "toml"
  ],
  "name": "TOML",
  "preCommands": [
    {
      "args": [
        "check",
        "--config",
        "~/.config/taplo/taplo.toml",
        "${file}"
      ],
      "command": "taplo",
      "name": "Taplo"
    }
  ]
}
```


## Go

```json
{
  "fixers": [
    {
      "args": [
        "-w",
        "${file}"
      ],
      "command": "gofmt",
      "name": "Go Format"
    }
  ],
  "languages": [
    "go"
  ],
  "name": "Go"
}
```


## Fish

```json
{
  "fixers": [
    {
      "args": [
        "-w",
        "${file}"
      ],
      "command": "fish_indent",
      "name": "Fish Format"
    }
  ],
  "languages": [
    "fish"
  ],
  "name": "Fish"
}
```


## JavaScript/TypeScript/Vue

```json
{
  "fixers": [
    {
      "args": [
        "--config",
        "~/.config/eslint/eslint.config.js",
        "--fix",
        "${file}"
      ],
      "command": "eslint",
      "name": "ESLint"
    },
    {
      "args": [
        "--write",
        "--config",
        "~/.prettierrc",
        "${file}"
      ],
      "command": "prettier",
      "enabled": false,
      "name": "Prettier"
    }
  ],
  "languages": [
    "javascript",
    "typescript",
    "javascriptreact",
    "typescriptreact",
    "vue"
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
  ],
  "name": "JavaScript/TypeScript/Vue"
}
```


## Styles

```json
{
  "fixers": [
    {
      "args": [
        "--config",
        "~/.stylelintrc.json",
        "--fix",
        "${file}"
      ],
      "command": "stylelint",
      "name": "Style Lint"
    },
    {
      "args": [
        "--write",
        "--config",
        "~/.prettierrc",
        "${file}"
      ],
      "command": "prettier",
      "enabled": false,
      "name": "Prettier"
    }
  ],
  "languages": [
    "css",
    "scss",
    "less"
  ],
  "linters": [
    {
      "args": [
        "--config",
        "~/.stylelintrc.json",
        "--formatter",
        "compact",
        "${file}"
      ],
      "command": "stylelint",
      "name": "Style Lint",
      "parser": {
        "flags": "gm",
        "pattern": "^.+?: line (?<line>\\d+), col (?<col>\\d+), (?<severity>\\w+) - (?<message>.+?) \\((?<code>[^)]+)\\)$"
      }
    }
  ],
  "name": "Styles"
}
```


## HTML

```json
{
  "fixers": [
    {
      "args": [
        "--write",
        "--config",
        "~/.prettierrc",
        "${file}"
      ],
      "command": "prettier",
      "name": "Prettier"
    }
  ],
  "languages": [
    "html"
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
      "args": [
        "--config",
        "~/.htmlhintrc",
        "--format",
        "unix",
        "${file}"
      ],
      "command": "htmlhint",
      "name": "HTML Hint",
      "parser": {
        "flags": "gm",
        "pattern": "^.+?:(?<line>\\d+):(?<col>\\d+): (?<message>.+) \\[(?<severity>[^/\\]]+)/(?<code>[^\\]]+)\\]$"
      }
    }
  ],
  "name": "HTML"
}
```


## SQL

```json
{
  "fixers": [
    {
      "args": [
        "fix",
        "--config",
        "~/.sqlfluff",
        "--dialect",
        "mysql",
        "${file}"
      ],
      "command": "sqlfluff",
      "name": "Sql Fluff"
    }
  ],
  "languages": [
    "sql"
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
  ],
  "name": "SQL"
}
```


## Make

```json
{
  "languages": [
    "makefile"
  ],
  "linters": [
    {
      "args": [
        "--config=~/.config/checkmake/checkmake.ini",
        "-o",
        "json",
        "${file}"
      ],
      "command": "checkmake",
      "name": "Check Make",
      "parser": {
        "flags": "g",
        "messageFormat": "json",
        "pattern": "\\{\\s*\"rule\":\\s*\"(?<code>[^\"]+)\",\\s*\"violation\":\\s*\"(?<message>(?:\\\\.|[^\"])*)\",\\s*\"file_name\":\\s*\"[^\"]+\",\\s*\"line_number\":\\s*(?<line>\\d+)\\s*\\}"
      }
    }
  ],
  "name": "Make"
}
```


## Nginx

```json
{
  "filePatterns": [
    "nginx.conf",
    "**/nginx/**/*.conf",
    "**/sites-available/*",
    "**/sites-enabled/*"
  ],
  "fixers": [
    {
      "args": [
        "-s",
        "4",
        "-i",
        "${file}"
      ],
      "command": "nginxbeautifier",
      "name": "Nginx Beautifier",
      "run": "onSave"
    }
  ],
  "languages": [
    "nginx",
    "plaintext"
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
  ],
  "name": "Nginx"
}
```


## XML

```json
{
  "filePatterns": [
    "*.xml",
    "*.xsd",
    "*.xsl",
    "*.xslt"
  ],
  "languages": [
    "xml",
    "xsl"
  ],
  "linters": [
    {
      "args": [
        "--nonet",
        "--noout",
        "${file}"
      ],
      "command": "xmllint",
      "name": "XML Lint",
      "parser": {
        "flags": "gm",
        "output": "stderr",
        "pattern": "^.+?:(?<line>\\d+): (?:(?:parser )?(?<severity>error|warning)) : (?<message>.+)$"
      }
    }
  ],
  "name": "XML",
  "preCommands": [
    {
      "args": [
        "--nonet",
        "--noout",
        "${file}"
      ],
      "command": "xmllint",
      "name": "XML Validate"
    }
  ]
}
```


## JSON

```json
{
  "fixers": [
    {
      "args": [
        "--write",
        "--config",
        "~/.prettierrc",
        "${file}"
      ],
      "command": "prettier",
      "name": "Prettier",
      "run": "onSave"
    }
  ],
  "languages": [
    "json",
    "jsonc"
  ],
  "linters": [
    {
      "args": [
        "-f",
        "~/.jsonlintrc",
        "${file}"
      ],
      "command": "jsonlint",
      "name": "JSON Lint",
      "parser": {
        "defaultSeverity": "error",
        "flags": "gm",
        "pattern": "^(?:.+?:\\s*)?line\\s+(?<line>\\d+),\\s*col\\s+(?<col>\\d+),\\s*(?<message>.+?)(?:\\.)?$"
      }
    }
  ],
  "name": "JSON"
}
```


## GitHub Actions

```json
{
  "filePatterns": [
    ".github/workflows/*.yml",
    ".github/workflows/*.yaml"
  ],
  "languages": [
    "github-actions-workflow",
    "yaml"
  ],
  "linters": [
    {
      "args": [
        "${file}"
      ],
      "command": "actionlint",
      "name": "Action Lint",
      "parser": {
        "defaultSeverity": "error",
        "flags": "gm",
        "pattern": "^.+?:(?<line>\\d+):(?<col>\\d+): (?<message>.+?) \\[(?<code>[^\\]]+)\\]$"
      }
    }
  ],
  "name": "GitHub Actions"
}
```


## Blade

```json
{
  "filePatterns": [
    "*.blade.php"
  ],
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
  ],
  "languages": [
    "blade",
    "php"
  ],
  "name": "Blade"
}
```


## PHP

```json
{
  "fixers": [
    {
      "args": [
        "fix",
        "--config",
        "~/.config/php-cs-fixer/php-cs-fixer.php",
        "${file}"
      ],
      "command": "php-cs-fixer",
      "env": {
        "PHP_CS_FIXER_IGNORE_ENV": "1"
      },
      "name": "PHP CS Fixer"
    },
    {
      "args": [
        "--standard=~/.config/phpcs/phpcs.xml",
        "-q",
        "--ignore-annotations",
        "--parallel=8",
        "--no-colors",
        "-d",
        "memory_limit=512M",
        "${file}"
      ],
      "command": "phpcbf",
      "name": "PHP Code Beautifier"
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
      "command": "rector",
      "name": "Rector",
      "run": "manual"
    },
    {
      "args": [
        "--colors=never",
        "format",
        "${file}"
      ],
      "command": "mago",
      "enabled": false,
      "name": "Mago Formatter"
    }
  ],
  "languages": [
    "php"
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
        "--no-colors",
        "-d",
        "memory_limit=512M",
        "${file}"
      ],
      "command": "phpcs",
      "maxFileSize": 75000,
      "name": "PHP CodeSniffer",
      "parser": {
        "flags": "gm",
        "pattern": "^.+?:(?<line>\\d+):(?<col>\\d+): (?<severity>warning|error) - (?<message>.+)$"
      },
      "timeout": 60000
    },
    {
      "args": [
        "${file}",
        "text",
        "~/.config/phpmd/phpmd.xml"
      ],
      "command": "phpmd",
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
      "command": "phpstan",
      "env": {
        "COMPOSER_MEMORY_LIMIT": "-1"
      },
      "name": "PHPStan",
      "parser": {
        "defaultSeverity": "error",
        "flags": "gm",
        "pattern": "^.+?:(?<line>\\d+):(?<message>.+?)(?: \\[identifier=(?<code>[^\\]]+)\\])?$"
      },
      "run": "manual"
    },
    {
      "args": [
        "--colors=never",
        "lint",
        "--reporting-format=emacs",
        "--minimum-report-level=warning",
        "--minimum-fail-level=warning",
        "${file}"
      ],
      "command": "mago",
      "name": "Mago Linter",
      "parser": {
        "defaultSeverity": "error",
        "flags": "gm",
        "pattern": "^.+?:(?<line>\\d+):(?<col>\\d+):\\s*(?:(?<severity>error|warning)|note|help)?:?\\s*(?:\\[(?<code>[^\\]]+)\\]\\s*)?(?<message>.+)$"
      }
    },
    {
      "args": [
        "--colors=never",
        "analyze",
        "--reporting-format=emacs",
        "--minimum-report-level=warning",
        "--minimum-fail-level=warning",
        "${file}"
      ],
      "command": "mago",
      "enabled": false,
      "name": "Mago Analyzer",
      "parser": {
        "defaultSeverity": "error",
        "flags": "gm",
        "pattern": "^.+?:(?<line>\\d+):(?<col>\\d+):\\s*(?:(?<severity>error|warning)|note|help)?:?\\s*(?:\\[(?<code>[^\\]]+)\\]\\s*)?(?<message>.+)$"
      },
      "run": "manual"
    },
    {
      "args": [
        "--colors=never",
        "guard",
        "--reporting-format=emacs",
        "--minimum-report-level=warning",
        "--minimum-fail-level=warning",
        "${file}"
      ],
      "command": "mago",
      "enabled": false,
      "name": "Mago Guard",
      "parser": {
        "defaultSeverity": "error",
        "flags": "gm",
        "pattern": "^.+?:(?<line>\\d+):(?<col>\\d+):\\s*(?:(?<severity>error|warning)|note|help)?:?\\s*(?:\\[(?<code>[^\\]]+)\\]\\s*)?(?<message>.+)$"
      },
      "run": "manual"
    }
  ],
  "name": "PHP",
  "preCommands": [
    {
      "args": [
        "-l",
        "${file}"
      ],
      "command": "php",
      "name": "PHP Lint"
    }
  ]
}
```
