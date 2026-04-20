# LintRunner

VS Code расширение для запуска внешних CLI линтеров и вывода найденных проблем в Problems.

## Возможности

- запуск линтеров вручную через `LintRunner: Run Linters`;
- запуск автофиксеров вручную через `LintRunner: Run Fixers`;
- запуск линтеров при сохранении файла;
- выбор линтеров по glob-паттернам файла;
- подстановка command variables в команды и аргументы;
- поддержка `~` в путях команд и аргументов;
- pre-commands перед основным линтером;
- скрытие diagnostic rule codes в Problems;
- status bar с именами активных линтеров.
- блокировка запуска команд в untrusted workspaces.

## Настройка

Конфиг хранится в `settings.json`:

```json
{
  "lintRunner.linters": [
    {
      "name": "phpcs",
      "filePatterns": ["*.php"],
      "command": "vendor/bin/phpcs",
      "args": ["--report=json", "${file}"],
      "fixCommand": {
        "command": "vendor/bin/phpcbf",
        "args": ["${file}"]
      },
      "parser": "json",
      "run": "onSave"
    }
  ]
}
```

## Linter Config

| Поле | Тип | Обязательное | Описание |
| --- | --- | --- | --- |
| `name` | `string` | да | Имя источника в Problems. |
| `filePatterns` | `string[]` | да | Glob-паттерны файлов. Проверяется имя файла, workspace-relative path и полный путь. |
| `command` | `string` | да | Команда линтера. Должна быть в `PATH` или абсолютным путем. Поддерживает `~` и command variables. |
| `args` | `string[]` | да | Аргументы команды. Поддерживает `~` и command variables. |
| `parser` | `string` | да | Parser вывода линтера. |
| `run` | `"onSave" \| "manual"` | да | Запуск при сохранении или только вручную. |
| `preCommands` | `CommandConfig[]` | нет | Команды перед основным линтером. |
| `fixCommand` | `CommandConfig` | нет | Команда автофиксера для `LintRunner: Run Fixers`. |
| `showDiagnosticCodes` | `boolean` | нет | Показывать rule codes в Problems. По умолчанию `true`. |

## Pre-Commands

`preCommands` выполняются последовательно перед основным линтером. Если одна команда завершается с non-zero exit code, основной линтер не запускается.

```json
{
  "name": "phpcs",
  "filePatterns": ["*.php"],
  "preCommands": [
    {
      "name": "php -l",
      "command": "php",
      "args": ["-l", "${file}"]
    }
  ],
  "command": "vendor/bin/phpcs",
  "args": ["--report=json", "${file}"],
  "parser": "json",
  "run": "onSave"
}
```

### Command Config

| Поле | Тип | Обязательное | Описание |
| --- | --- | --- | --- |
| `name` | `string` | нет | Имя команды в LintRunner output. |
| `command` | `string` | да | Исполняемый файл. Поддерживает `~` и command variables. |
| `args` | `string[]` | да | Аргументы. Поддерживает `~` и command variables. |

## Command Variables

LintRunner подставляет переменные в `command`, `args`, `preCommands[*].command`, `preCommands[*].args`, `fixCommand.command` и `fixCommand.args`.

| Переменная | Значение |
| --- | --- |
| `${file}` | Полный путь к файлу. |
| `${workspaceFolder}` | Путь к workspace folder файла. Пустая строка, если файл вне workspace. |
| `${relativeFile}` | Путь файла относительно workspace folder. Если файл вне workspace, полный путь. |
| `${fileDirname}` | Директория файла. |
| `${fileBasename}` | Имя файла с расширением. |
| `${fileBasenameNoExtension}` | Имя файла без расширения. |
| `${fileExtname}` | Расширение файла, включая точку. |

Неизвестные переменные остаются без изменений.

## Workspace Trust

LintRunner не запускает команды из workspace config, пока workspace не trusted. В untrusted workspace команды `LintRunner: Run Linters`, `LintRunner: Run Fixers` и запуск при сохранении пропускаются.

## Fix Commands

`fixCommand` выполняется только через `LintRunner: Run Fixers`. Для всех matching configs команды выполняются последовательно. После фиксеров расширение запускает линтеры вручную, чтобы обновить Problems.

```json
{
  "name": "phpcs",
  "filePatterns": ["*.php"],
  "command": "vendor/bin/phpcs",
  "args": ["--report=json", "${file}"],
  "fixCommand": {
    "name": "phpcbf",
    "command": "vendor/bin/phpcbf",
    "args": ["${file}"]
  },
  "parser": "json",
  "run": "onSave"
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
  "name": "phpcs",
  "filePatterns": ["*.php"],
  "command": "vendor/bin/phpcs",
  "args": ["--report=json", "${file}"],
  "parser": "json",
  "run": "onSave",
  "showDiagnosticCodes": false
}
```

Результат:

```text
Expected 1 newline at end of file; 0 found phpcs
```

## Parsers

| Parser | Формат |
| --- | --- |
| `json` | JSON output с полями `line`, `column`, `message`, `level`/`severity`/`type`, `code`/`rule`/`ruleId`. Также поддерживает phpcs JSON. |
| `jsonlint` | `line N, col N, message`. |
| `parsable` | `file:line:column: [level] message`. |
| `xmllint` | stderr формата `file:line: error: message` или `file:line: warning: message`. |
| `linthtml` | `line:column error message  rule`. |
| `ansible-lint` | rule line + location line из стандартного вывода ansible-lint. |

## Примеры

### PHP

```json
{
  "lintRunner.linters": [
    {
      "name": "phpcs",
      "filePatterns": ["*.php"],
      "preCommands": [
        {
          "name": "php -l",
          "command": "php",
          "args": ["-l", "${file}"]
        }
      ],
      "command": "vendor/bin/phpcs",
      "args": ["--report=json", "${file}"],
      "parser": "json",
      "run": "onSave",
      "showDiagnosticCodes": false
    }
  ]
}
```

### Nginx

```json
{
  "lintRunner.linters": [
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
      "command": "nginx-lint",
      "args": ["${file}"],
      "parser": "parsable",
      "run": "manual"
    }
  ]
}
```

### XML

```json
{
  "lintRunner.linters": [
    {
      "name": "xmllint",
      "filePatterns": ["*.xml"],
      "command": "xmllint",
      "args": ["--noout", "${file}"],
      "parser": "xmllint",
      "run": "onSave"
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
