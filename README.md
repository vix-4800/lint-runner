# LintRunner

VS Code расширение для запуска внешних CLI линтеров и вывода найденных проблем в Problems.

## Возможности

- запуск линтеров вручную через `LintRunner: Run Linters`;
- запуск линтеров при сохранении файла;
- выбор линтеров по glob-паттернам файла;
- подстановка `${file}` в аргументы;
- поддержка `~` в путях команд и аргументов;
- pre-commands перед основным линтером;
- скрытие diagnostic rule codes в Problems;
- status bar с именами активных линтеров.

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
| `command` | `string` | да | Команда линтера. Должна быть в `PATH` или абсолютным путем. |
| `args` | `string[]` | да | Аргументы команды. Поддерживает `${file}` и `~`. |
| `parser` | `string` | да | Parser вывода линтера. |
| `run` | `"onSave" \| "manual"` | да | Запуск при сохранении или только вручную. |
| `preCommands` | `CommandConfig[]` | нет | Команды перед основным линтером. |
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
| `command` | `string` | да | Исполняемый файл. |
| `args` | `string[]` | да | Аргументы. Поддерживает `${file}` и `~`. |

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
