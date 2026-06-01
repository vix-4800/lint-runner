import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { diagnosticHasExplicitColumn, diagnosticHasExplicitRange } from './parser/diagnostic.js';
import { parseRegexOutput, type RegexParserConfig } from './parser/regexParser.js';

const runningTools = new Map<string, number>();
const activeRunIds = new Map<string, number>();
const activeFileProcesses = new Map<string, Set<cp.ChildProcess>>();
const fileToolDiagnostics = new Map<string, Map<string, vscode.Diagnostic[]>>();
let nextRunId = 0;
let commandEnvPromise: Promise<NodeJS.ProcessEnv> | undefined;

const SHELL_ENV_TIMEOUT_MS = 3000;
const DOCTOR_VERSION_TIMEOUT_MS = 3000;
const SHELL_PATH_PREFIX = 'LINT_RUNNER_PATH=';
const TIMEOUT_MS = 30_000;
const REQUIRED_PARSER_GROUPS = ['line', 'message'] as const;
const NAMED_CAPTURE_GROUP_RE = /(?<!\\)\(\?<([A-Za-z][A-Za-z0-9]*)>/g;
const PIPELINE_NAMES = ['manual', 'onOpen', 'onSave'] as const;
const UNSUPPORTED_TARGET_KEYS = [
    `file${'Patterns'}`,
    `fix${'ers'}`,
    'languages',
    `lin${'ters'}`,
    `pre${'Commands'}`,
    'run',
] as const;

export type RunMode = (typeof PIPELINE_NAMES)[number];
export type ToolKind = 'diagnostic' | 'write';
export type PipelineStrategy = 'parallel' | 'sequence';
export type CommandEnv = Record<string, string>;
export type RunnerOutput = Pick<vscode.OutputChannel, 'appendLine'> & {
    reportFailure?: (failure: RunnerFailure) => void;
};
export type DoctorToolFoundStatus = 'no' | 'unknown' | 'yes';
export type WorkspaceConfigLike = Pick<vscode.WorkspaceConfiguration, 'get'>;
export type { RegexParserConfig };

export interface RunnerFailure {
    label: string;
    message: string;
}

export interface CommandConfig {
    command: string;
    args: string[];
    cwd?: string;
    env?: CommandEnv;
}

export interface CommandResult {
    code: number | null;
    stdout: string;
    stderr: string;
    error?: string;
}

export interface ToolConfig extends CommandConfig {
    kind: ToolKind;
    enabled?: boolean;
    parser?: RegexParserConfig;
    timeout?: number;
    maxFileSize?: number;
    successExitCodes?: number[];
}

export type ToolPatch = Partial<Omit<ToolConfig, 'kind'>> & {
    kind?: ToolKind;
};

export interface TargetMatchConfig {
    languages?: string[];
    files?: string[];
    exclude?: string[];
}

export interface PipelineConfig {
    strategy: PipelineStrategy;
    tools: string[];
}

export interface ToolTargetDefinition {
    name: string;
    match?: TargetMatchConfig;
    manual?: PipelineConfig;
    onSave?: PipelineConfig;
    onOpen?: PipelineConfig;
}

export type ToolTargetOverride = Partial<Omit<ToolTargetDefinition, 'name'>> & {
    name: string;
    [key: string]: unknown;
};

export interface ToolConfigurationPatch {
    vars?: Record<string, string>;
    tools?: Record<string, ToolPatch>;
    targets?: ToolTargetOverride[];
}

export interface ResolvedToolConfiguration {
    vars: Record<string, string>;
    tools: Record<string, ToolConfig>;
    targets: ToolTargetDefinition[];
}

export interface ToolValidationScope {
    label: string;
    config: ToolConfigurationPatch;
}

export interface ValidateToolConfigScopesOptions {
    knownLanguageIds?: Iterable<string>;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
}

export interface ConfigValidationIssues {
    errors: string[];
    warnings: string[];
}

export interface RunnableTool {
    label: string;
    description: string;
    detail: string;
    targetName: string;
    pipelineName: RunMode;
    toolName: string;
    tool: ToolConfig;
    vars?: Record<string, string>;
}

export interface RunnablePipeline {
    label: string;
    description: string;
    detail: string;
    target: ToolTargetDefinition;
    pipelineName: RunMode;
    pipeline: PipelineConfig;
    tools: RunnableTool[];
}

export interface DoctorToolStatus {
    tool: string;
    found: DoctorToolFoundStatus;
    version: string;
    usedBy: string[];
}

export function isLintRunnerEnabled(
    resourceOrConfig: vscode.Uri | WorkspaceConfigLike = vscode.workspace.getConfiguration('lintRunner')
): boolean {
    const config =
        resourceOrConfig instanceof vscode.Uri
            ? vscode.workspace.getConfiguration('lintRunner', resourceOrConfig)
            : resourceOrConfig;
    return config.get<boolean>('enabled') !== false;
}

function getOrCreateToolMap(uriString: string): Map<string, vscode.Diagnostic[]> {
    let map = fileToolDiagnostics.get(uriString);
    if (map === undefined) {
        map = new Map();
        fileToolDiagnostics.set(uriString, map);
    }
    return map;
}

function toolDiagnosticKey(targetName: string, toolName: string): string {
    return `${targetName}\x00${toolName}`;
}

function republishMergedDiagnostics(
    uri: vscode.Uri,
    toolMap: Map<string, vscode.Diagnostic[]>,
    diagnostics: vscode.DiagnosticCollection
): void {
    const merged = [...toolMap.values()].flat();
    if (merged.length === 0) {
        diagnostics.delete(uri);
        return;
    }
    diagnostics.set(uri, merged);
}

export function clearFileToolDiagnostics(uriString: string): void {
    fileToolDiagnostics.delete(uriString);
}

export function clearAllFileToolDiagnostics(): void {
    fileToolDiagnostics.clear();
}

export function clearDiagnosticsCache(): void {
    fileToolDiagnostics.clear();
}

export function clearFileDiagnosticsCache(filePath: string): void {
    fileToolDiagnostics.delete(vscode.Uri.file(filePath).toString());
}

function registerProcess(filePath: string, proc: cp.ChildProcess): void {
    let procs = activeFileProcesses.get(filePath);
    if (procs === undefined) {
        procs = new Set();
        activeFileProcesses.set(filePath, procs);
    }
    procs.add(proc);
}

function unregisterProcess(filePath: string, proc: cp.ChildProcess): void {
    const procs = activeFileProcesses.get(filePath);
    if (procs === undefined) {
        return;
    }
    procs.delete(proc);
    if (procs.size === 0) {
        activeFileProcesses.delete(filePath);
    }
}

function terminateProcessTree(proc: cp.ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
    if (proc.pid !== undefined && process.platform !== 'win32') {
        try {
            process.kill(-proc.pid, signal);
            return;
        } catch {
            // Fall through to direct child termination.
        }
    }
    proc.kill(signal);
}

function killFileProcesses(filePath: string): void {
    const procs = activeFileProcesses.get(filePath);
    if (procs === undefined) {
        return;
    }
    activeFileProcesses.delete(filePath);
    for (const proc of procs) {
        terminateProcessTree(proc);
    }
}

function startFileRun(filePath: string): number {
    const runId = nextRunId++;
    activeRunIds.set(filePath, runId);
    killFileProcesses(filePath);
    return runId;
}

function isActiveFileRun(filePath: string, runId: number): boolean {
    return activeRunIds.get(filePath) === runId;
}

function finishFileRun(filePath: string, runId: number): void {
    if (isActiveFileRun(filePath, runId)) {
        activeRunIds.delete(filePath);
    }
}

export function cancelFileRun(filePath: string): void {
    activeRunIds.delete(filePath);
    killFileProcesses(filePath);
}

export function cancelAllFileRuns(): void {
    for (const filePath of new Set([...activeRunIds.keys(), ...activeFileProcesses.keys()])) {
        cancelFileRun(filePath);
    }
}

export function clearRunnerRuntimeState(): void {
    cancelAllFileRuns();
    runningTools.clear();
    activeRunIds.clear();
    activeFileProcesses.clear();
    clearAllFileToolDiagnostics();
    resetCommandEnv();
}

function pushValidationIssue(issues: string[], scopeLabel: string, message: string): void {
    issues.push(`${scopeLabel}: ${message}`);
}

function pushValidationError(issues: ConfigValidationIssues, scopeLabel: string, message: string): void {
    pushValidationIssue(issues.errors, scopeLabel, message);
}

function pushValidationWarning(issues: ConfigValidationIssues, scopeLabel: string, message: string): void {
    pushValidationIssue(issues.warnings, scopeLabel, message);
}

function collectNamedCaptureGroups(pattern: string): Set<string> {
    const groups = new Set<string>();
    for (const match of pattern.matchAll(NAMED_CAPTURE_GROUP_RE)) {
        const name = match[1];
        if (name !== undefined) {
            groups.add(name);
        }
    }
    return groups;
}

function hasRequiredParserGroups(parser: RegexParserConfig): { valid: boolean; missingGroups: string[] } {
    const groups = collectNamedCaptureGroups(parser.pattern);
    const missingGroups = REQUIRED_PARSER_GROUPS.filter((group) => !groups.has(group));
    return { valid: missingGroups.length === 0, missingGroups };
}

function validateParserConfig(
    scopeLabel: string,
    ownerLabel: string,
    parser: RegexParserConfig | undefined,
    issues: ConfigValidationIssues
): void {
    if (parser === undefined || typeof parser.pattern !== 'string' || parser.pattern.length === 0) {
        pushValidationError(issues, scopeLabel, `${ownerLabel} parser is missing pattern.`);
        return;
    }

    const flags = parser.flags ?? 'g';
    const normalizedFlags = flags.includes('g') ? flags : `${flags}g`;
    try {
        new RegExp(parser.pattern, normalizedFlags);
    } catch {
        pushValidationError(issues, scopeLabel, `${ownerLabel} parser has an invalid regex pattern.`);
        return;
    }

    const { valid, missingGroups } = hasRequiredParserGroups(parser);
    if (!valid) {
        pushValidationError(
            issues,
            scopeLabel,
            `${ownerLabel} parser is missing required capture groups: ${missingGroups.join(', ')}.`
        );
    }
}

function hasCommandAndArgs(command: string | undefined, args: string[] | undefined): boolean {
    return typeof command === 'string' && command.trim() !== '' && Array.isArray(args);
}

function expandHome(value: string): string {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
    return value.replace(/(^|=)~(?=\/|$)/, `$1${home}`);
}

function isCommandPathLike(command: string): boolean {
    return command.includes('/') || command.includes('\\');
}

function isCommandSafelyCheckable(command: string): boolean {
    return command.trim() !== '' && !command.includes('${');
}

function isExecutablePath(filePath: string, platform: NodeJS.Platform): boolean {
    try {
        fs.accessSync(filePath, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

function getPathKey(env: NodeJS.ProcessEnv): string {
    return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
}

function commandExistsForValidation(
    command: string,
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform
): boolean | undefined {
    const expandedCommand = expandHome(command.trim());
    if (!isCommandSafelyCheckable(expandedCommand)) {
        return undefined;
    }
    if (path.isAbsolute(expandedCommand)) {
        return isExecutablePath(expandedCommand, platform);
    }
    if (isCommandPathLike(expandedCommand)) {
        return undefined;
    }

    const pathValue = env[getPathKey(env)] ?? '';
    const directories = pathValue.split(path.delimiter).filter((entry) => entry !== '');
    const hasExtension = path.extname(expandedCommand) !== '';
    const executableNames =
        platform === 'win32' && !hasExtension
            ? (env.PATHEXT?.split(';').filter((entry) => entry !== '') ?? ['.COM', '.EXE', '.BAT', '.CMD'])
                .map((extension) => `${expandedCommand}${extension}`)
            : [expandedCommand];

    for (const directory of directories) {
        for (const executableName of executableNames) {
            if (isExecutablePath(path.join(directory, executableName), platform)) {
                return true;
            }
        }
    }
    return false;
}

function validateCommandAvailability(
    scopeLabel: string,
    ownerLabel: string,
    command: string | undefined,
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
    issues: ConfigValidationIssues
): void {
    if (command === undefined || command.trim() === '') {
        return;
    }
    if (!isCommandSafelyCheckable(command)) {
        pushValidationWarning(
            issues,
            scopeLabel,
            `${ownerLabel} command '${command}' cannot be checked because it contains variables.`
        );
        return;
    }
    if (commandExistsForValidation(command, env, platform) === false) {
        pushValidationWarning(issues, scopeLabel, `${ownerLabel} command '${command}' was not found.`);
    }
}

function validateSuccessExitCodes(
    scopeLabel: string,
    ownerLabel: string,
    successExitCodes: unknown,
    issues: ConfigValidationIssues
): void {
    if (successExitCodes === undefined) {
        return;
    }
    if (
        !Array.isArray(successExitCodes) ||
        successExitCodes.some((code) => typeof code !== 'number' || !Number.isInteger(code))
    ) {
        pushValidationError(issues, scopeLabel, `${ownerLabel} successExitCodes must be an array of integers.`);
    }
}

function cloneToolPatch(tool: ToolPatch): ToolPatch {
    return {
        ...tool,
        args: tool.args !== undefined ? [...tool.args] : undefined,
        env: tool.env !== undefined ? { ...tool.env } : undefined,
        parser: tool.parser !== undefined ? { ...tool.parser } : undefined,
        successExitCodes: tool.successExitCodes !== undefined ? [...tool.successExitCodes] : undefined,
    };
}

function isPipelineConfig(value: unknown): value is PipelineConfig {
    if (value === undefined || typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const candidate = value as Partial<PipelineConfig>;
    return (
        (candidate.strategy === 'parallel' || candidate.strategy === 'sequence') &&
        Array.isArray(candidate.tools) &&
        candidate.tools.every((tool) => typeof tool === 'string' && tool.trim() !== '')
    );
}

function clonePipelineConfig(pipeline: PipelineConfig | undefined): PipelineConfig | undefined {
    return pipeline === undefined || !isPipelineConfig(pipeline)
        ? undefined
        : { strategy: pipeline.strategy, tools: [...pipeline.tools] };
}

function cloneTargetOverride(target: ToolTargetOverride): ToolTargetOverride {
    return {
        ...target,
        match: target.match !== undefined
            ? {
                languages: target.match.languages !== undefined ? [...target.match.languages] : undefined,
                files: target.match.files !== undefined ? [...target.match.files] : undefined,
                exclude: target.match.exclude !== undefined ? [...target.match.exclude] : undefined,
            }
            : undefined,
        manual: clonePipelineConfig(target.manual),
        onOpen: clonePipelineConfig(target.onOpen),
        onSave: clonePipelineConfig(target.onSave),
    };
}

export function mergeToolConfiguration(
    base: ToolConfigurationPatch,
    patch: ToolConfigurationPatch
): ToolConfigurationPatch {
    const tools: Record<string, ToolPatch> = {};
    for (const [name, tool] of Object.entries(base.tools ?? {})) {
        tools[name] = cloneToolPatch(tool);
    }
    for (const [name, tool] of Object.entries(patch.tools ?? {})) {
        tools[name] = {
            ...(tools[name] ?? {}),
            ...cloneToolPatch(tool),
            args: tool.args === undefined ? tools[name]?.args : [...tool.args],
            env: tool.env === undefined ? tools[name]?.env : { ...tool.env },
            parser: tool.parser === undefined ? tools[name]?.parser : { ...tool.parser },
            successExitCodes:
                tool.successExitCodes === undefined ? tools[name]?.successExitCodes : [...tool.successExitCodes],
        };
    }

    const targets = (base.targets ?? []).map(cloneTargetOverride);
    for (const targetOverride of patch.targets ?? []) {
        const existingIndex = targets.findIndex((target) => target.name === targetOverride.name);
        if (existingIndex === -1) {
            targets.push(cloneTargetOverride(targetOverride));
            continue;
        }
        const existing = targets[existingIndex];
        const clonedOverride = cloneTargetOverride(targetOverride);
        targets[existingIndex] = {
            ...existing,
            ...clonedOverride,
            match: targetOverride.match === undefined ? existing.match : { ...existing.match, ...clonedOverride.match },
            manual: targetOverride.manual === undefined ? existing.manual : clonedOverride.manual,
            onOpen: targetOverride.onOpen === undefined ? existing.onOpen : clonedOverride.onOpen,
            onSave: targetOverride.onSave === undefined ? existing.onSave : clonedOverride.onSave,
        };
    }

    return {
        vars: { ...(base.vars ?? {}), ...(patch.vars ?? {}) },
        tools,
        targets,
    };
}

export function resolveToolConfiguration(config: ToolConfigurationPatch): ResolvedToolConfiguration {
    const tools: Record<string, ToolConfig> = {};
    for (const [name, tool] of Object.entries(config.tools ?? {})) {
        if (tool.kind !== undefined && typeof tool.command === 'string' && Array.isArray(tool.args)) {
            tools[name] = {
                ...cloneToolPatch(tool),
                kind: tool.kind,
                command: tool.command,
                args: [...tool.args],
                cwd: tool.cwd ?? '${workspaceFolder}',
                successExitCodes: tool.successExitCodes !== undefined ? [...tool.successExitCodes] : [0],
            };
        }
    }

    return {
        vars: { ...(config.vars ?? {}) },
        tools,
        targets: (config.targets ?? []).map((target) => ({
            name: target.name,
            match: target.match,
            manual: clonePipelineConfig(target.manual),
            onOpen: clonePipelineConfig(target.onOpen),
            onSave: clonePipelineConfig(target.onSave),
        })),
    };
}

function validateVars(scopeLabel: string, vars: Record<string, string> | undefined, issues: ConfigValidationIssues): void {
    if (vars === undefined) {
        return;
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (name: string): void => {
        if (visited.has(name)) {
            return;
        }
        if (visiting.has(name)) {
            pushValidationError(issues, scopeLabel, `var '${name}' contains a circular reference.`);
            return;
        }
        visiting.add(name);
        for (const match of (vars[name] ?? '').matchAll(/\$\{(\w+)}/g)) {
            const ref = match[1];
            if (ref !== undefined && Object.hasOwn(vars, ref)) {
                visit(ref);
            }
        }
        visiting.delete(name);
        visited.add(name);
    };

    for (const [name, value] of Object.entries(vars)) {
        if (typeof value !== 'string') {
            pushValidationError(issues, scopeLabel, `var '${name}' must be a string.`);
            continue;
        }
        visit(name);
    }
}

export function validateToolConfigScopes(
    scopes: readonly ToolValidationScope[],
    options: ValidateToolConfigScopesOptions = {}
): ConfigValidationIssues {
    const issues: ConfigValidationIssues = { errors: [], warnings: [] };
    const knownLanguageIds = new Set(options.knownLanguageIds ?? []);
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    let merged: ToolConfigurationPatch = {};

    for (const scope of scopes) {
        validateVars(scope.label, scope.config.vars, issues);
        const toolsAfterScope = { ...(merged.tools ?? {}), ...(scope.config.tools ?? {}) };

        for (const [toolName, tool] of Object.entries(scope.config.tools ?? {})) {
            const mergedTool = { ...(merged.tools?.[toolName] ?? {}), ...tool };
            const label = `tool '${toolName}'`;
            if (mergedTool.enabled === false) {
                continue;
            }
            if (mergedTool.kind !== 'diagnostic' && mergedTool.kind !== 'write') {
                pushValidationError(issues, scope.label, `${label} kind must be 'diagnostic' or 'write'.`);
            }
            if (!hasCommandAndArgs(mergedTool.command, mergedTool.args)) {
                pushValidationError(issues, scope.label, `${label} is missing command or args.`);
            }
            if (mergedTool.kind === 'diagnostic') {
                validateParserConfig(scope.label, label, mergedTool.parser, issues);
            }
            if (mergedTool.kind === 'write' && mergedTool.parser !== undefined) {
                pushValidationError(issues, scope.label, `${label} with kind 'write' must not define parser.`);
            }
            validateCommandAvailability(
                scope.label,
                label,
                mergedTool.command,
                mergeCommandEnv(env, mergedTool.env),
                platform,
                issues
            );
            validateSuccessExitCodes(scope.label, label, mergedTool.successExitCodes, issues);
        }

        const seenTargetNames = new Set<string>();
        for (const target of scope.config.targets ?? []) {
            const targetLabel = `target '${target.name}'`;
            if (seenTargetNames.has(target.name)) {
                pushValidationError(issues, scope.label, `duplicate target name '${target.name}'.`);
            }
            seenTargetNames.add(target.name);

            for (const key of UNSUPPORTED_TARGET_KEYS) {
                if (Object.hasOwn(target, key)) {
                    pushValidationError(issues, scope.label, `${targetLabel} contains unsupported key '${key}'.`);
                }
            }
            for (const languageId of target.match?.languages ?? []) {
                if (languageId !== '*' && !knownLanguageIds.has(languageId)) {
                    pushValidationWarning(issues, scope.label, `${targetLabel} contains unknown language id '${languageId}'.`);
                }
            }
            for (const pipelineName of PIPELINE_NAMES) {
                const rawPipeline = target[pipelineName];
                if (rawPipeline === undefined) {
                    continue;
                }
                if (!isPipelineConfig(rawPipeline)) {
                    pushValidationError(
                        issues,
                        scope.label,
                        `${targetLabel} pipeline '${pipelineName}' must be an object with strategy and tools.`
                    );
                    continue;
                }
                for (const toolRef of rawPipeline.tools) {
                    if (toolsAfterScope[toolRef] === undefined) {
                        pushValidationError(
                            issues,
                            scope.label,
                            `${targetLabel} pipeline '${pipelineName}' references unknown tool '${toolRef}'.`
                        );
                    }
                }
            }
        }

        merged = mergeToolConfiguration(merged, scope.config);
    }
    return issues;
}

function getScopedToolConfigPatches(resource?: vscode.Uri): ToolValidationScope[] {
    const config =
        resource === undefined
            ? vscode.workspace.getConfiguration('lintRunner')
            : vscode.workspace.getConfiguration('lintRunner', resource);
    const inspectedVars = config.inspect<Record<string, string>>('vars');
    const inspectedTools = config.inspect<Record<string, ToolPatch>>('tools');
    const inspectedTargets = config.inspect<ToolTargetOverride[]>('targets');
    const folderName = resource === undefined ? undefined : vscode.workspace.getWorkspaceFolder(resource)?.name;

    return [
        {
            label: 'User settings',
            config: {
                vars: inspectedVars?.globalValue,
                tools: inspectedTools?.globalValue,
                targets: inspectedTargets?.globalValue,
            },
        },
        {
            label: 'Workspace settings',
            config: {
                vars: inspectedVars?.workspaceValue,
                tools: inspectedTools?.workspaceValue,
                targets: inspectedTargets?.workspaceValue,
            },
        },
        {
            label: folderName === undefined ? 'Folder settings' : `Folder settings (${folderName})`,
            config: {
                vars: inspectedVars?.workspaceFolderValue,
                tools: inspectedTools?.workspaceFolderValue,
                targets: inspectedTargets?.workspaceFolderValue,
            },
        },
    ].filter((scope) =>
        scope.config.vars !== undefined ||
        scope.config.tools !== undefined ||
        scope.config.targets !== undefined
    );
}

function mergeToolConfigScopes(scopes: readonly ToolValidationScope[]): ToolConfigurationPatch {
    let merged: ToolConfigurationPatch = {};
    for (const scope of scopes) {
        merged = mergeToolConfiguration(merged, scope.config);
    }
    return merged;
}

export async function validateLintRunnerConfig(resource?: vscode.Uri): Promise<ConfigValidationIssues> {
    const [knownLanguageIds, env] = await Promise.all([
        vscode.languages.getLanguages(),
        getCommandEnv(),
    ]);
    return validateToolConfigScopes(getScopedToolConfigPatches(resource), { knownLanguageIds, env });
}

export function getConfiguredToolConfiguration(resource?: vscode.Uri): ResolvedToolConfiguration {
    return resolveToolConfiguration(mergeToolConfigScopes(getScopedToolConfigPatches(resource)));
}

function normalizePath(value: string): string {
    return value.replace(/\\/g, '/');
}

function globPatternToRegexBody(pattern: string): string {
    let body = '';
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        const next = pattern[i + 1];
        if (c === '*' && next === '*') {
            body += '.*';
            i++;
            if (pattern[i + 1] === '/') {
                i++;
            }
        } else if (c === '*') {
            body += '[^/]*';
        } else if (c === '?') {
            body += '[^/]';
        } else if (c === '[') {
            let j = i + 1;
            if (j < pattern.length && (pattern[j] === '!' || pattern[j] === '^')) {
                j++;
            }
            if (j < pattern.length && pattern[j] === ']') {
                j++;
            }
            while (j < pattern.length && pattern[j] !== ']') {
                j++;
            }
            if (j < pattern.length) {
                let inner = pattern.slice(i + 1, j);
                if (inner.startsWith('!')) {
                    inner = `^${inner.slice(1)}`;
                }
                body += `[${inner}]`;
                i = j;
            } else {
                body += '\\[';
            }
        } else if (c === '{') {
            let j = i + 1;
            let depth = 1;
            while (j < pattern.length && depth > 0) {
                if (pattern[j] === '{') {
                    depth++;
                } else if (pattern[j] === '}') {
                    depth--;
                }
                j++;
            }
            if (depth === 0) {
                const inner = pattern.slice(i + 1, j - 1);
                const parts: string[] = [];
                let start = 0;
                let innerDepth = 0;
                for (let k = 0; k < inner.length; k++) {
                    if (inner[k] === '{') {
                        innerDepth++;
                    } else if (inner[k] === '}') {
                        innerDepth--;
                    } else if (inner[k] === ',' && innerDepth === 0) {
                        parts.push(inner.slice(start, k));
                        start = k + 1;
                    }
                }
                parts.push(inner.slice(start));
                body += `(?:${parts.map(globPatternToRegexBody).join('|')})`;
                i = j - 1;
            } else {
                body += '\\{';
            }
        } else if (/[.+^$}()|[\]\\]/.test(c)) {
            body += `\\${c}`;
        } else {
            body += c;
        }
    }
    return body;
}

function globToRegex(pattern: string): RegExp {
    return new RegExp(`^${globPatternToRegexBody(normalizePath(pattern))}$`);
}

function collectPathMatchCandidates(filePath: string): string[] {
    const candidates = new Set<string>([path.basename(filePath)]);
    const workspaceFolder = resolveWorkingDirectory(filePath);

    const addPathCandidates = (value: string): void => {
        const normalizedValue = normalizePath(value);
        if (normalizedValue.length === 0) {
            return;
        }
        candidates.add(normalizedValue);

        const trimmedValue = normalizedValue.replace(/^\/+/, '');
        if (trimmedValue.length === 0) {
            return;
        }

        const parts = trimmedValue.split('/').filter((part) => part.length > 0);
        for (let i = 0; i < parts.length; i++) {
            candidates.add(parts.slice(i).join('/'));
        }
    };

    addPathCandidates(workspaceFolder === undefined ? filePath : path.relative(workspaceFolder, filePath));
    addPathCandidates(filePath);

    return [...candidates];
}

function matchesPatterns(filePath: string, patterns: readonly string[] = []): boolean {
    const candidates = collectPathMatchCandidates(filePath);
    return patterns.some((pattern) => {
        const regex = globToRegex(pattern);
        return candidates.some((candidate) => regex.test(candidate));
    });
}

export function matchesIgnorePatterns(filePath: string, patterns: readonly string[] = []): boolean {
    return matchesPatterns(filePath, patterns);
}

function getDocumentLanguageId(filePath: string): string | undefined {
    const normalized = path.resolve(filePath);
    return vscode.workspace.textDocuments.find((document) => path.resolve(document.fileName) === normalized)?.languageId;
}

function matchesLanguageId(languages: readonly string[] = [], languageId: string | undefined): boolean {
    if (languageId === undefined) {
        return false;
    }
    return languages.includes('*') || languages.includes(languageId);
}

function matchesTarget(filePath: string, target: ToolTargetDefinition): boolean {
    if (target.match?.exclude !== undefined && matchesPatterns(filePath, target.match.exclude)) {
        return false;
    }
    if (target.match?.languages !== undefined && target.match.languages.length > 0) {
        if (!matchesLanguageId(target.match.languages, getDocumentLanguageId(filePath))) {
            return false;
        }
    }
    if (target.match?.files !== undefined && target.match.files.length > 0) {
        return matchesPatterns(filePath, target.match.files);
    }
    return true;
}

function runnableToolFromConfig(
    config: ResolvedToolConfiguration,
    target: ToolTargetDefinition,
    pipelineName: RunMode,
    toolName: string,
    tool: ToolConfig
): RunnableTool {
    return {
        label: toolName,
        description: `${target.name} / ${pipelineName}`,
        detail: `${tool.kind}: ${tool.command} ${tool.args.join(' ')}`,
        targetName: target.name,
        pipelineName,
        toolName,
        tool,
        vars: config.vars,
    };
}

export function collectRunnablePipelines(
    config: ResolvedToolConfiguration,
    filePath: string,
    trigger: RunMode
): RunnablePipeline[] {
    const result: RunnablePipeline[] = [];
    for (const target of config.targets) {
        if (!matchesTarget(filePath, target)) {
            continue;
        }
        const pipeline = target[trigger] ?? (trigger === 'onSave' ? target.onOpen : undefined);
        if (pipeline === undefined) {
            continue;
        }
        const tools = pipeline.tools
            .map((toolName) => {
                const tool = config.tools[toolName];
                return tool === undefined || tool.enabled === false
                    ? undefined
                    : runnableToolFromConfig(config, target, trigger, toolName, tool);
            })
            .filter((tool): tool is RunnableTool => tool !== undefined);
        if (tools.length === 0) {
            continue;
        }
        result.push({
            label: `${target.name}: ${trigger}`,
            description: `${pipeline.strategy}, ${tools.length} tool(s)`,
            detail: tools.map((tool) => tool.toolName).join(', '),
            target,
            pipelineName: trigger,
            pipeline,
            tools,
        });
    }
    return result;
}

export function getRunnablePipelines(filePath: string, trigger: RunMode = 'manual'): RunnablePipeline[] {
    return collectRunnablePipelines(getConfiguredToolConfiguration(vscode.Uri.file(filePath)), filePath, trigger);
}

export function getRunnableTools(filePath: string, trigger: RunMode = 'manual'): RunnableTool[] {
    return getRunnablePipelines(filePath, trigger).flatMap((pipeline) => pipeline.tools);
}

function resolveWorkingDirectory(filePath: string): string | undefined {
    return vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath))?.uri.fsPath;
}

interface CommandTemplateValues {
    file: string;
    workspaceFolder: string;
    relativeFile: string;
    fileDirname: string;
    fileBasename: string;
    fileBasenameNoExtension: string;
    fileExtname: string;
}

function buildCommandTemplateValues(filePath: string): CommandTemplateValues {
    const workspaceFolder = resolveWorkingDirectory(filePath) ?? '';
    const fileExtname = path.extname(filePath);
    return {
        file: filePath,
        workspaceFolder,
        relativeFile: workspaceFolder === '' ? filePath : path.relative(workspaceFolder, filePath),
        fileDirname: path.dirname(filePath),
        fileBasename: path.basename(filePath),
        fileBasenameNoExtension: path.basename(filePath, fileExtname),
        fileExtname,
    };
}

function resolveTemplateVar(
    key: string,
    builtIns: CommandTemplateValues,
    vars: Record<string, string>,
    seen: Set<string>
): string | undefined {
    if (Object.hasOwn(builtIns, key)) {
        return builtIns[key as keyof CommandTemplateValues];
    }
    const value = vars[key];
    if (value === undefined || seen.has(key)) {
        return undefined;
    }
    seen.add(key);
    return value.replace(/\$\{(\w+)\}/g, (match, nestedKey: string) =>
        resolveTemplateVar(nestedKey, builtIns, vars, seen) ?? match
    );
}

export function applyCommandTemplate(
    value: string,
    filePath: string,
    vars: Record<string, string> = {}
): string {
    const builtIns = buildCommandTemplateValues(filePath);
    return value.replace(/\$\{(\w+)\}/g, (match, key: string) =>
        resolveTemplateVar(key, builtIns, vars, new Set()) ?? match
    );
}

function mergePathValues(...values: string[]): string {
    return [...new Set(values.flatMap((value) => value.split(path.delimiter)).filter((value) => value !== ''))]
        .join(path.delimiter);
}

export function buildCommandEnv(shellPath?: string): NodeJS.ProcessEnv {
    const env = { ...process.env };
    if (shellPath === undefined || shellPath === '') {
        return env;
    }
    const pathKey = getPathKey(env);
    env[pathKey] = mergePathValues(shellPath, env[pathKey] ?? '');
    return env;
}

function mergeCommandEnv(
    baseEnv: NodeJS.ProcessEnv,
    overrides: CommandEnv | undefined,
    filePath?: string,
    vars: Record<string, string> = {}
): NodeJS.ProcessEnv {
    const env = Object.fromEntries(Object.entries(baseEnv)) as NodeJS.ProcessEnv;
    for (const [key, value] of Object.entries(overrides ?? {})) {
        env[key] = filePath === undefined ? value : expandHome(applyCommandTemplate(value, filePath, vars));
    }
    return env;
}

function getShellPathCommand(shell: string): string {
    return path.basename(shell) === 'fish'
        ? `printf '${SHELL_PATH_PREFIX}%s\\n' (string join ${path.delimiter} $PATH)`
        : `printf '${SHELL_PATH_PREFIX}%s\\n' "$PATH"`;
}

function parseShellPath(stdout: string): string | undefined {
    const lines = stdout.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].startsWith(SHELL_PATH_PREFIX)) {
            return lines[i].slice(SHELL_PATH_PREFIX.length);
        }
    }
    return undefined;
}

function getLoginShell(): string | undefined {
    return process.env.SHELL ?? os.userInfo().shell ?? undefined;
}

async function resolveShellPath(): Promise<string | undefined> {
    const shell = getLoginShell();
    if (shell === undefined || process.platform === 'win32') {
        return await Promise.resolve(undefined);
    }
    return await new Promise((resolve) => {
        const proc = cp.spawn(shell, ['-lc', getShellPathCommand(shell)]);
        let stdout = '';
        let done = false;
        const timer = setTimeout(() => {
            if (done) {
                return;
            }
            done = true;
            proc.kill();
            resolve(undefined);
        }, SHELL_ENV_TIMEOUT_MS);
        proc.stdout?.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
        });
        proc.on('error', () => {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(timer);
            resolve(undefined);
        });
        proc.on('close', () => {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(timer);
            resolve(parseShellPath(stdout));
        });
    });
}

async function getCommandEnv(): Promise<NodeJS.ProcessEnv> {
    commandEnvPromise ??= resolveShellPath().then(buildCommandEnv);
    return await commandEnvPromise;
}

export function resetCommandEnv(): void {
    commandEnvPromise = undefined;
}

function buildArgs(args: string[], filePath: string, vars: Record<string, string>): string[] {
    return args.map((arg) => expandHome(applyCommandTemplate(arg, filePath, vars)));
}

function buildCommandCwd(commandConfig: CommandConfig, filePath: string, vars: Record<string, string>): string | undefined {
    const defaultCwd = resolveWorkingDirectory(filePath);
    if (commandConfig.cwd === undefined) {
        return defaultCwd;
    }
    const cwd = expandHome(applyCommandTemplate(commandConfig.cwd, filePath, vars)).trim();
    if (cwd === '') {
        return defaultCwd;
    }
    return path.isAbsolute(cwd) ? cwd : path.resolve(defaultCwd ?? path.dirname(filePath), cwd);
}

function formatCommandPart(value: string): string {
    return /\s/.test(value) ? JSON.stringify(value) : value;
}

function formatCommand(command: string, args: string[]): string {
    return [command, ...args].map(formatCommandPart).join(' ');
}

function formatCommandStatus(result: CommandResult): string {
    if (result.error !== undefined) {
        return `failed: ${result.error}`;
    }
    return result.code === 0 ? 'ok' : `exit ${result.code ?? 'null'}`;
}

function isAcceptedExitCode(result: CommandResult, successExitCodes?: readonly number[]): boolean {
    if (result.error !== undefined) {
        return false;
    }
    return result.code !== null && (successExitCodes ?? [0]).includes(result.code);
}

function formatExitCodePolicyFailure(result: CommandResult, successExitCodes?: readonly number[]): string {
    if (result.error !== undefined) {
        return result.error;
    }
    return `exit ${result.code ?? 'null'} is not in successExitCodes [${(successExitCodes ?? [0]).join(', ')}]`;
}

function reportCommandFailure(output: RunnerOutput, label: string, message: string): void {
    output.reportFailure?.({ label, message });
}

function formatRunningToolName(name: string, count: number): string {
    return count > 1 ? `${name} x${count}` : name;
}

function updateStatusBar(statusBar: vscode.StatusBarItem): void {
    const names = [...runningTools.entries()].map(([name, count]) => formatRunningToolName(name, count));
    if (names.length === 0) {
        statusBar.hide();
        return;
    }
    statusBar.text = `$(sync~spin) LintRunner: ${names.join(', ')}`;
    statusBar.tooltip = `Running tools: ${names.join(', ')}\nClick to stop all running tools.`;
    statusBar.show();
}

function startToolStatus(name: string, statusBar: vscode.StatusBarItem): void {
    runningTools.set(name, (runningTools.get(name) ?? 0) + 1);
    updateStatusBar(statusBar);
}

function stopToolStatus(name: string, statusBar: vscode.StatusBarItem): void {
    const count = runningTools.get(name) ?? 0;
    if (count <= 1) {
        runningTools.delete(name);
    } else {
        runningTools.set(name, count - 1);
    }
    updateStatusBar(statusBar);
}

async function runCommand(
    label: string,
    commandConfig: CommandConfig,
    filePath: string,
    output: RunnerOutput,
    shouldContinue: () => boolean,
    timeoutMs: number,
    vars: Record<string, string>
): Promise<CommandResult> {
    if (!vscode.workspace.isTrusted) {
        output.appendLine(`[${label}] skipped: workspace is not trusted`);
        return { code: null, stdout: '', stderr: '', error: 'workspace is not trusted' };
    }

    const command = expandHome(applyCommandTemplate(commandConfig.command, filePath, vars));
    const args = buildArgs(commandConfig.args, filePath, vars);
    const cwd = buildCommandCwd(commandConfig, filePath, vars);
    const env = mergeCommandEnv(await getCommandEnv(), commandConfig.env, filePath, vars);
    if (!shouldContinue()) {
        return { code: null, stdout: '', stderr: '', error: 'cancelled' };
    }
    output.appendLine(`[${label}] ${formatCommand(command, args)}`);

    return await new Promise((resolve) => {
        let proc: cp.ChildProcess;
        try {
            proc = cp.spawn(command, args, {
                cwd,
                detached: process.platform !== 'win32',
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
        } catch (err) {
            resolve({ code: null, stdout: '', stderr: '', error: String(err) });
            return;
        }

        registerProcess(filePath, proc);
        let stdout = '';
        let stderr = '';
        let done = false;
        const timer = setTimeout(() => {
            if (done) {
                return;
            }
            done = true;
            unregisterProcess(filePath, proc);
            terminateProcessTree(proc);
            output.appendLine(`[${label}] killed: timeout after ${timeoutMs}ms`);
            resolve({ code: null, stdout, stderr, error: 'timeout' });
        }, timeoutMs);
        proc.stdout?.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
        });
        proc.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });
        proc.on('error', (err: Error) => {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(timer);
            unregisterProcess(filePath, proc);
            resolve({ code: null, stdout, stderr, error: err.message });
        });
        proc.on('close', (code: number | null) => {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(timer);
            unregisterProcess(filePath, proc);
            resolve({ code, stdout, stderr });
        });
    });
}

function findDiagnosticEndCharacter(text: string, startCharacter: number): number {
    let endCharacter = startCharacter;
    while (endCharacter < text.length && !/\s/.test(text[endCharacter])) {
        endCharacter++;
    }
    return Math.max(startCharacter + 1, endCharacter);
}

export async function normalizeDiagnosticRanges(filePath: string, diagnostics: vscode.Diagnostic[]): Promise<void> {
    if (diagnostics.length === 0) {
        return;
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    for (const diagnostic of diagnostics) {
        if (diagnosticHasExplicitRange(diagnostic) || diagnostic.range.start.line >= document.lineCount) {
            continue;
        }
        const line = document.lineAt(diagnostic.range.start.line);
        if (line.isEmptyOrWhitespace) {
            continue;
        }
        const startCharacter = diagnosticHasExplicitColumn(diagnostic)
            ? diagnostic.range.start.character
            : line.firstNonWhitespaceCharacterIndex;
        const boundedStartCharacter = Math.min(Math.max(0, startCharacter), Math.max(0, line.text.length - 1));
        diagnostic.range = new vscode.Range(
            diagnostic.range.start.line,
            boundedStartCharacter,
            diagnostic.range.start.line,
            findDiagnosticEndCharacter(line.text, boundedStartCharacter)
        );
    }
}

export function shouldProcessToolFile(fileSize: number, maxFileSize?: number): boolean {
    return maxFileSize === undefined || fileSize <= maxFileSize;
}

function selectParserOutput(config: RegexParserConfig, result: CommandResult): string {
    if (config.output === 'stdout') {
        return result.stdout;
    }
    if (config.output === 'stderr') {
        return result.stderr;
    }
    return `${result.stdout}\n${result.stderr}`;
}

export function parseToolOutput(toolName: string, tool: ToolConfig, result: CommandResult): vscode.Diagnostic[] {
    if (tool.kind !== 'diagnostic' || tool.parser === undefined) {
        return [];
    }
    return parseRegexOutput(selectParserOutput(tool.parser, result), tool.parser, toolName);
}

async function shouldSkipFile(filePath: string): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('lintRunner', vscode.Uri.file(filePath));
    if (config.get<string[]>('ignorePatterns', []).some((pattern) => matchesPatterns(filePath, [pattern]))) {
        return true;
    }
    return false;
}

async function runRunnableTool(
    filePath: string,
    runnable: RunnableTool,
    output: RunnerOutput,
    statusBar: vscode.StatusBarItem,
    diagnostics: vscode.DiagnosticCollection | undefined,
    shouldContinue: () => boolean
): Promise<boolean> {
    const tool = runnable.tool;
    const statusName = `${runnable.targetName}: ${runnable.toolName}`;
    startToolStatus(statusName, statusBar);
    try {
        if (tool.kind === 'diagnostic' && tool.maxFileSize !== undefined) {
            const fileStat = await fs.promises.stat(filePath);
            if (!shouldProcessToolFile(fileStat.size, tool.maxFileSize)) {
                output.appendLine(
                    `[${runnable.toolName}] skipped: file size ${fileStat.size} exceeds maxFileSize ${tool.maxFileSize}`
                );
                return true;
            }
        }

        const result = await runCommand(
            runnable.toolName,
            tool,
            filePath,
            output,
            shouldContinue,
            tool.timeout ?? TIMEOUT_MS,
            runnable.vars ?? {}
        );
        output.appendLine(`[${runnable.toolName}] done: ${formatCommandStatus(result)}`);
        if (!isAcceptedExitCode(result, tool.successExitCodes)) {
            const failureMessage = formatExitCodePolicyFailure(result, tool.successExitCodes);
            output.appendLine(`[${runnable.toolName}] failed: ${failureMessage}`);
            reportCommandFailure(output, runnable.toolName, failureMessage);
            return false;
        }

        if (tool.kind === 'diagnostic' && diagnostics !== undefined) {
            const parsedDiagnostics = parseToolOutput(runnable.toolName, tool, result);
            await normalizeDiagnosticRanges(filePath, parsedDiagnostics);
            const uri = vscode.Uri.file(filePath);
            const toolMap = getOrCreateToolMap(uri.toString());
            toolMap.set(toolDiagnosticKey(runnable.targetName, runnable.toolName), parsedDiagnostics);
            republishMergedDiagnostics(uri, toolMap, diagnostics);
        }
        return true;
    } catch (err) {
        const failureMessage = String(err);
        output.appendLine(`[${runnable.toolName}] failed: ${failureMessage}`);
        reportCommandFailure(output, runnable.toolName, failureMessage);
        return false;
    } finally {
        stopToolStatus(statusName, statusBar);
    }
}

function diagnosticToolsAfterWrite(pipeline: RunnablePipeline, lastWriteIndex: number): RunnableTool[] {
    const afterWrite = pipeline.tools.slice(lastWriteIndex + 1).filter((tool) => tool.tool.kind === 'diagnostic');
    if (afterWrite.length > 0) {
        return [];
    }
    return pipeline.tools.filter((tool) => tool.tool.kind === 'diagnostic');
}

export async function runPipeline(
    filePath: string,
    pipeline: RunnablePipeline,
    output: RunnerOutput,
    statusBar: vscode.StatusBarItem,
    diagnostics?: vscode.DiagnosticCollection
): Promise<number> {
    const runId = startFileRun(filePath);
    const shouldContinue = (): boolean => isActiveFileRun(filePath, runId);
    let successfulTools = 0;
    let lastSuccessfulWriteIndex = -1;

    try {
        if (await shouldSkipFile(filePath)) {
            return 0;
        }
        if (pipeline.pipeline.strategy === 'parallel') {
            const results = await Promise.all(
                pipeline.tools.map(async (tool, index) => ({
                    index,
                    kind: tool.tool.kind,
                    success: await runRunnableTool(filePath, tool, output, statusBar, diagnostics, shouldContinue),
                }))
            );
            successfulTools = results.filter((result) => result.success).length;
            const writeIndexes = results
                .filter((result) => result.success && result.kind === 'write')
                .map((result) => result.index);
            lastSuccessfulWriteIndex = writeIndexes.length === 0 ? -1 : Math.max(...writeIndexes);
        } else {
            for (const [index, tool] of pipeline.tools.entries()) {
                if (!shouldContinue()) {
                    break;
                }
                const success = await runRunnableTool(filePath, tool, output, statusBar, diagnostics, shouldContinue);
                if (!success) {
                    break;
                }
                successfulTools++;
                if (tool.tool.kind === 'write') {
                    lastSuccessfulWriteIndex = index;
                }
            }
        }

        if (lastSuccessfulWriteIndex >= 0 && shouldContinue()) {
            for (const diagnosticTool of diagnosticToolsAfterWrite(pipeline, lastSuccessfulWriteIndex)) {
                if (!shouldContinue()) {
                    break;
                }
                await runRunnableTool(filePath, diagnosticTool, output, statusBar, diagnostics, shouldContinue);
            }
        }
        return successfulTools;
    } finally {
        finishFileRun(filePath, runId);
    }
}

function extractCommandVersion(output: string): string | undefined {
    const firstLine = output.split(/\r?\n/).find((line) => line.trim() !== '');
    return firstLine?.trim();
}

async function detectCommandVersion(command: string, cwd: string | undefined, env: NodeJS.ProcessEnv): Promise<string | undefined> {
    return await new Promise((resolve) => {
        let proc: cp.ChildProcess;
        try {
            proc = cp.spawn(command, ['--version'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch {
            resolve(undefined);
            return;
        }
        let output = '';
        const timer = setTimeout(() => {
            proc.kill();
            resolve(undefined);
        }, DOCTOR_VERSION_TIMEOUT_MS);
        proc.stdout?.on('data', (chunk: Buffer) => {
            output += chunk.toString();
        });
        proc.stderr?.on('data', (chunk: Buffer) => {
            output += chunk.toString();
        });
        proc.on('error', () => {
            clearTimeout(timer);
            resolve(undefined);
        });
        proc.on('close', () => {
            clearTimeout(timer);
            resolve(extractCommandVersion(output));
        });
    });
}

export async function collectDoctorToolStatuses(
    config: ResolvedToolConfiguration,
    deps?: {
        checkCommand?: (command: string) => boolean | undefined;
        detectVersion?: (command: string) => Promise<string | undefined>;
    }
): Promise<DoctorToolStatus[]> {
    const checkCommand = deps?.checkCommand ?? (() => undefined);
    const detectVersion = deps?.detectVersion ?? (async () => undefined);
    const tools = new Map<string, Set<string>>();

    for (const target of config.targets) {
        for (const pipelineName of PIPELINE_NAMES) {
            const pipeline = target[pipelineName];
            if (pipeline === undefined) {
                continue;
            }
            for (const toolName of pipeline.tools) {
                const tool = config.tools[toolName];
                if (tool === undefined || tool.enabled === false) {
                    continue;
                }
                const usedBy = tools.get(tool.command) ?? new Set<string>();
                usedBy.add(`${target.name} / ${pipelineName} / ${toolName}`);
                tools.set(tool.command, usedBy);
            }
        }
    }

    const statuses: DoctorToolStatus[] = [];
    for (const [tool, usedBySet] of Array.from(tools.entries()).sort(([left], [right]) => left.localeCompare(right))) {
        const exists = checkCommand(tool);
        const found: DoctorToolFoundStatus = exists === true ? 'yes' : exists === false ? 'no' : 'unknown';
        statuses.push({
            tool,
            found,
            version: found === 'yes' ? (await detectVersion(tool)) ?? '-' : '-',
            usedBy: Array.from(usedBySet).sort((left, right) => left.localeCompare(right)),
        });
    }
    return statuses;
}

function getDoctorResource(resource?: vscode.Uri): vscode.Uri | undefined {
    return resource ?? vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
}

function getDoctorWorkingDirectory(resource?: vscode.Uri): string | undefined {
    return resource === undefined ? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath : resolveWorkingDirectory(resource.fsPath);
}

export async function getDoctorToolStatuses(resource?: vscode.Uri): Promise<DoctorToolStatus[]> {
    const scopedResource = getDoctorResource(resource);
    const env = await getCommandEnv();
    return await collectDoctorToolStatuses(getConfiguredToolConfiguration(scopedResource), {
        checkCommand: (command) => commandExistsForValidation(command, env, process.platform),
        detectVersion: async (command) => {
            if (!isCommandSafelyCheckable(command)) {
                return undefined;
            }
            return await detectCommandVersion(expandHome(command.trim()), getDoctorWorkingDirectory(scopedResource), env);
        },
    });
}
