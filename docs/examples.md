# Configuration Examples

The snippets below are copied from a real working VS Code setup.

The first block shows top-level `lintRunner.*` settings. Each target section after that keeps the original header and splits the example into target-level settings plus utility-specific fragments.

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

These fragments belong to the same `lintRunner.targets` entry.

### Target settings

```json
{
  "languages": [
    "php"
  ],
  "name": "GitLeaks"
}
```

### gitleaks (linter)

```json
{
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
  ]
}
```


## Shell

These fragments belong to the same `lintRunner.targets` entry.

### Target settings

```json
{
  "languages": [
    "shellscript"
  ],
  "name": "Shell"
}
```

### shellcheck (linter)

```json
{
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
  ]
}
```

### shfmt (fixer)

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
  ]
}
```


## Dockerfile

These fragments belong to the same `lintRunner.targets` entry.

### Target settings

```json
{
  "languages": [
    "dockerfile"
  ],
  "name": "Dockerfile"
}
```

### hadolint (linter)

```json
{
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

These fragments belong to the same `lintRunner.targets` entry.

### Target settings

```json
{
  "languages": [
    "markdown"
  ],
  "name": "Markdown"
}
```

### Markdown Lint (linter)

```json
{
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
  ]
}
```

### Markdown Lint (fixer)

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
    }
  ]
}
```

### prettier (fixer)

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
      "enabled": false,
      "name": "Prettier"
    }
  ]
}
```


## YAML

These fragments belong to the same `lintRunner.targets` entry.

### Target settings

```json
{
  "languages": [
    "yaml",
    "dockercompose"
  ],
  "name": "YAML"
}
```

### yamllint (linter)

```json
{
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
  ]
}
```

### yamlfmt (fixer)

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
  ]
}
```


## Ansible

These fragments belong to the same `lintRunner.targets` entry.

### Target settings

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
  "name": "Ansible"
}
```

### ansible-lint (linter)

```json
{
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
  ]
}
```


## Python

These fragments belong to the same `lintRunner.targets` entry.

### Target settings

```json
{
  "languages": [
    "python"
  ],
  "name": "Python"
}
```

### Ruff (linter)

```json
{
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

### Ruff Fix (fixer)

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
    }
  ]
}
```

### Ruff Format (fixer)

```json
{
  "fixers": [
    {
      "args": [
        "format",
        "--config=~/.config/ruff/pyproject.toml",
        "${file}"
      ],
      "command": "ruff",
      "name": "Ruff Format"
    }
  ]
}
```


## Dotenv

These fragments belong to the same `lintRunner.targets` entry.

### Target settings

```json
{
  "filePatterns": [
    ".env",
    ".env.*"
  ],
  "languages": [
    "dotenv",
    "shellscript"
  ],
  "name": "Dotenv"
}
```

### Dotenv Linter (linter)

```json
{
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
  ]
}
```

### Dotenv Linter (fixer)

```json
{
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
  ]
}
```


## INI

These fragments belong to the same `lintRunner.targets` entry.

### Target settings

```json
{
  "languages": [
    "ini",
    "properties",
    "editorconfig"
  ],
  "name": "INI"
}
```

### inifmt (fixer)

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
  ]
}
```


## Lua

These fragments belong to the same `lintRunner.targets` entry.

### Target settings

```json
{
  "languages": [
    "lua"
  ],
  "name": "Lua"
}
```

### luacheck (linter)

```json
{
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

### stylua (fixer)

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
  ]
}
```


## TOML

These fragments belong to the same `lintRunner.targets` entry.

### Target settings

```json
{
  "languages": [
    "toml"
  ],
  "name": "TOML"
}
```

### Taplo (pre-command)

```json
{
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

### Taplo (fixer)

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
  ]
}
```


## Go

These fragments belong to the same `lintRunner.targets` entry.

### Target settings

```json
{
  "languages": [
    "go"
  ],
  "name": "Go"
}
```

### gofmt (fixer)

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
  ]
}
```


## Fish

These fragments belong to the same `lintRunner.targets` entry.

### Target settings

```json
{
  "languages": [
    "fish"
  ],
  "name": "Fish"
}
```

### fish_indent (fixer)

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
  ]
}
```


## JavaScript/TypeScript/Vue

These fragments belong to the same `lintRunner.targets` entry.

### Target settings

```json
{
  "languages": [
    "javascript",
    "typescript",
    "javascriptreact",
    "typescriptreact",
    "vue"
  ],
  "name": "JavaScript/TypeScript/Vue"
}
```

### ESLint (linter)

```json
{
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

### ESLint (fixer)

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
    }
  ]
}
```

### prettier (fixer)

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
      "enabled": false,
      "name": "Prettier"
    }
  ]
}
```


## Styles

These fragments belong to the same `lintRunner.targets` entry.

### Target settings

```json
{
  "languages": [
    "css",
    "scss",
    "less"
  ],
  "name": "Styles"
}
```

### Style Lint (linter)

```json
{
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
  ]
}
```

### Style Lint (fixer)

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
    }
  ]
}
```

### prettier (fixer)

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
      "enabled": false,
      "name": "Prettier"
    }
  ]
}
```


## HTML

These fragments belong to the same `lintRunner.targets` entry.

### Target settings

```json
{
  "languages": [
    "html"
  ],
  "name": "HTML"
}
```

### Lint HTML (linter)

```json
{
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
    }
  ]
}
```

### htmlhint (linter)

```json
{
  "linters": [
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
  ]
}
```

### prettier (fixer)

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
  ]
}
```


## SQL

These fragments belong to the same `lintRunner.targets` entry.

### Target settings

```json
{
  "languages": [
    "sql"
  ],
  "name": "SQL"
}
```

### Sql Fluff (linter)

```json
{
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

### Sql Fluff (fixer)

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
  ]
}
```


## Make

These fragments belong to the same `lintRunner.targets` entry.

### Target settings

```json
{
  "languages": [
    "makefile"
  ],
  "name": "Make"
}
```

### checkmake (linter)

```json
{
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
  ]
}
```


## Nginx

These fragments belong to the same `lintRunner.targets` entry.

### Target settings

```json
{
  "filePatterns": [
    "nginx.conf",
    "**/nginx/**/*.conf",
    "**/sites-available/*",
    "**/sites-enabled/*"
  ],
  "languages": [
    "nginx",
    "plaintext"
  ],
  "name": "Nginx"
}
```

### nginx-lint (linter)

```json
{
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

### nginxbeautifier (fixer)

```json
{
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
  ]
}
```


## XML

These fragments belong to the same `lintRunner.targets` entry.

### Target settings

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
  "name": "XML"
}
```

### XML Validate (pre-command)

```json
{
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

### XML Lint (linter)

```json
{
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
  ]
}
```


## JSON

These fragments belong to the same `lintRunner.targets` entry.

### Target settings

```json
{
  "languages": [
    "json",
    "jsonc"
  ],
  "name": "JSON"
}
```

### jsonlint (linter)

```json
{
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
  ]
}
```

### prettier (fixer)

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
  ]
}
```


## GitHub Actions

These fragments belong to the same `lintRunner.targets` entry.

### Target settings

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
  "name": "GitHub Actions"
}
```

### actionlint (linter)

```json
{
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
  ]
}
```


## Blade

These fragments belong to the same `lintRunner.targets` entry.

### Target settings

```json
{
  "filePatterns": [
    "*.blade.php"
  ],
  "languages": [
    "blade",
    "php"
  ],
  "name": "Blade"
}
```

### blade-formatter (fixer)

```json
{
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

These fragments belong to the same `lintRunner.targets` entry.

### Target settings

```json
{
  "languages": [
    "php"
  ],
  "name": "PHP"
}
```

### php (pre-command)

```json
{
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

### phpcs (linter)

```json
{
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
    }
  ]
}
```

### phpmd (linter)

```json
{
  "linters": [
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
    }
  ]
}
```

### phpstan (linter)

```json
{
  "linters": [
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

### Mago Linter (linter)

```json
{
  "linters": [
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
    }
  ]
}
```

### Mago Analyzer (linter)

```json
{
  "linters": [
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
    }
  ]
}
```

### Mago Guard (linter)

```json
{
  "linters": [
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
  ]
}
```

### php-cs-fixer (fixer)

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
      "name": "PHP CS Fixer"
    }
  ]
}
```

### phpcbf (fixer)

```json
{
  "fixers": [
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
    }
  ]
}
```

### rector (fixer)

```json
{
  "fixers": [
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
    }
  ]
}
```

### Mago Formatter (fixer)

```json
{
  "fixers": [
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
  ]
}
```
