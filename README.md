# LintRunner

VS Code расширение для запуска внешних CLI линтеров и вывода найденных проблем в Problems.

## Возможности

- запуск линтеров вручную через `LintRunner: Run Linters`;
- запуск автофиксеров вручную через `LintRunner: Run Fixers`;
- запуск линтеров при открытии файла;
- запуск линтеров при сохранении файла;
- выбор линтеров по glob-паттернам файла;
- подстановка command variables в команды и аргументы;
- поддержка `~` в путях команд и аргументов;
- pre-commands перед основным линтером;
- скрытие diagnostic rule codes в Problems;
- status bar с именами активных линтеров;
- блокировка запуска команд в untrusted workspaces.

## Настройка

Конфиг хранится в `settings.json`:

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
            "fixers": [{ "name": "phpcbf", "command": "vendor/bin/phpcbf", "args": ["${file}"] }]
        }
    ]
}
```

## Target Config

`lintRunner.targets` группирует общий file set и команды, которые нужно запускать для этих файлов.

| Поле                  | Тип                    | Обязательное | Описание                                                                            |
| --------------------- | ---------------------- | ------------ | ----------------------------------------------------------------------------------- |
| `name`                | `string`               | да           | Имя target в LintRunner output.                                                     |
| `filePatterns`        | `string[]`             | да           | Glob-паттерны файлов. Проверяется имя файла, workspace-relative path и полный путь. |
| `run`                 | `"onOpen" \| "onSave" \| "manual"` | нет          | Режим запуска по умолчанию для linters. По умолчанию `onSave`.                      |
| `preCommands`         | `CommandConfig[]`      | нет          | Команды, которые выполняются один раз перед linters target.                         |
| `linters`             | `TargetLinterConfig[]` | нет          | Команды линтеров для target.                                                        |
| `fixers`              | `CommandConfig[]`      | нет          | Команды автофиксеров для `LintRunner: Run Fixers`.                                  |
| `showDiagnosticCodes` | `boolean`              | нет          | Значение по умолчанию для linters target.                                           |

### Target Linter Config

| Поле                  | Тип                    | Обязательное | Описание                                                                                          |
| --------------------- | ---------------------- | ------------ | ------------------------------------------------------------------------------------------------- |
| `name`                | `string`               | да           | Имя источника в Problems.                                                                         |
| `command`             | `string`               | да           | Команда линтера. Должна быть в `PATH` или абсолютным путем. Поддерживает `~` и command variables. |
| `args`                | `string[]`             | да           | Аргументы команды. Поддерживает `~` и command variables.                                          |
| `parser`              | `string`               | да           | Parser вывода линтера.                                                                            |
| `run`                 | `"onOpen" \| "onSave" \| "manual"` | нет          | Переопределяет `run` target.                                                                      |
| `preCommands`         | `CommandConfig[]`      | нет          | Команды перед основным линтером.                                                                  |
| `fixCommand`          | `CommandConfig`        | нет          | Legacy per-linter auto-fixer. Для новых конфигов лучше `fixers` на target.                        |
| `showDiagnosticCodes` | `boolean`              | нет          | Переопределяет `showDiagnosticCodes` target.                                                      |

`lintRunner.linters` со старым linter-first форматом всё ещё поддерживается для совместимости.

## Pre-Commands

`preCommands` выполняются последовательно перед основным линтером. Если одна команда завершается с non-zero exit code,
основной линтер не запускается.

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

| Поле      | Тип        | Обязательное | Описание                                                |
| --------- | ---------- | ------------ | ------------------------------------------------------- |
| `name`    | `string`   | нет          | Имя команды в LintRunner output.                        |
| `command` | `string`   | да           | Исполняемый файл. Поддерживает `~` и command variables. |
| `args`    | `string[]` | да           | Аргументы. Поддерживает `~` и command variables.        |

## Command Variables

LintRunner подставляет переменные в `command`, `args`, `preCommands[*].command`, `preCommands[*].args`,
`fixCommand.command` и `fixCommand.args`.

| Переменная                   | Значение                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `${file}`                    | Полный путь к файлу.                                                            |
| `${workspaceFolder}`         | Путь к workspace folder файла. Пустая строка, если файл вне workspace.          |
| `${relativeFile}`            | Путь файла относительно workspace folder. Если файл вне workspace, полный путь. |
| `${fileDirname}`             | Директория файла.                                                               |
| `${fileBasename}`            | Имя файла с расширением.                                                        |
| `${fileBasenameNoExtension}` | Имя файла без расширения.                                                       |
| `${fileExtname}`             | Расширение файла, включая точку.                                                |

Неизвестные переменные остаются без изменений.

## Workspace Trust

LintRunner не запускает команды из workspace config, пока workspace не trusted. В untrusted workspace команды
`LintRunner: Run Linters`, `LintRunner: Run Fixers`, запуск при открытии и запуск при сохранении пропускаются.

## Fix Commands

`fixCommand` выполняется только через `LintRunner: Run Fixers`. Для всех matching configs команды выполняются
последовательно. После фиксеров расширение запускает линтеры вручную, чтобы обновить Problems.

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
    "fixers": [{ "name": "phpcbf", "command": "vendor/bin/phpcbf", "args": ["${file}"] }]
}
```

## Diagnostic Codes

По умолчанию VS Code показывает rule code:

```text
Expected 1 newline at end of file; 0 found phpcs(PSR2.Files.EndFileNewline.NoneFound)
```

Чтобы скрыть rule code:

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

Результат:

```text
Expected 1 newline at end of file; 0 found phpcs
```

## Parsers

| Parser         | Формат                                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `json`         | JSON output с полями `line`, `column`, `message`, `level`/`severity`/`type`, `code`/`rule`/`ruleId`. Также поддерживает phpcs JSON. |
| `jsonlint`     | `line N, col N, message`.                                                                                                           |
| `parsable`     | `file:line:column: [level] message`.                                                                                                |
| `xmllint`      | stderr формата `file:line: error: message` или `file:line: warning: message`.                                                       |
| `linthtml`     | `line:column error message  rule`.                                                                                                  |
| `ansible-lint` | rule line + location line из стандартного вывода ansible-lint.                                                                      |

## Примеры

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

## Разработка

```bash
npm install
npm run compile
npm run lint
npm test
```
