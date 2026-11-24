import * as path from 'path';
import { AsyncLocalStorage } from 'async_hooks';
import { MinigamePlatform, NativePlatform, WebPlatform } from './platform-config';

const ENVIRONMENT_KEY = 'COCOS_ENGINE_PLATFORM_DEFINITIONS';
const RESERVED_CONSTANTS = new Set([
    'HTML5', 'NATIVE', 'MINIGAME', 'RUNTIME_BASED', 'SUPPORT_JIT', 'JSB', 'NODEJS',
    'INVALID_PLATFORM', 'BUILD', 'EDITOR', 'EDITOR_NOT_IN_PREVIEW', 'PREVIEW', 'TEST',
    'DEBUG', 'DEV', 'SERVER_MODE', 'NOT_PACK_PHYSX_LIBS', 'NET_MODE', 'WEBGPU',
    'NATIVE_CODE_BUNDLE_MODE',
]);

/** Serializable engine-platform definition. */
export interface PlatformDefinition {
    id: string;
    category: 'web' | 'minigame' | 'native';
    /** Runtime-based games use RUNTIME_BASED instead of MINIGAME. */
    runtimeMode?: 'web' | 'minigame' | 'runtime' | 'native';
    /** Virtual PAL specifier -> engine-relative implementation. */
    moduleOverrides?: Record<string, string>;
}

export type DisposePlatform = () => void;

interface Registration {
    definition: Readonly<PlatformDefinition>;
    references: number;
    inherited: boolean;
}

const registrations = new Map<string, Registration>();
const scope = new AsyncLocalStorage<readonly Readonly<PlatformDefinition>[]>();
const initialEnvironmentValue = process.env[ENVIRONMENT_KEY];

function cloneDefinition (value: Readonly<PlatformDefinition>): PlatformDefinition {
    return {
        ...value,
        ...(value.moduleOverrides ? { moduleOverrides: { ...value.moduleOverrides } } : {}),
    };
}

function freezeDefinition (value: Readonly<PlatformDefinition>): Readonly<PlatformDefinition> {
    const cloned = cloneDefinition(value);
    if (cloned.moduleOverrides) { Object.freeze(cloned.moduleOverrides); }
    return Object.freeze(cloned);
}

function sameDefinition (left: Readonly<PlatformDefinition>, right: Readonly<PlatformDefinition>): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

export function validatePlatformDefinitions (values: readonly PlatformDefinition[]): PlatformDefinition[] {
    if (!Array.isArray(values)) { throw new Error('platformDefinitions must be an array'); }
    const result = new Map<string, PlatformDefinition>();
    for (const value of values) {
        if (!value || !/^[A-Z][A-Z0-9_]*$/.test(value.id)
            || !['web', 'minigame', 'native'].includes(value.category)) {
            throw new Error('Invalid platform definition');
        }
        if (value.id in WebPlatform || value.id in NativePlatform || value.id in MinigamePlatform
            || RESERVED_CONSTANTS.has(value.id)) {
            throw new Error('Cannot redefine built-in platform: ' + value.id);
        }
        const runtimeMode = value.runtimeMode || value.category;
        if (!(value.category === 'minigame' ? ['minigame', 'runtime'] : [value.category]).includes(runtimeMode)) {
            throw new Error('Invalid runtimeMode for ' + value.id);
        }
        if (value.moduleOverrides !== undefined
            && (!value.moduleOverrides || typeof value.moduleOverrides !== 'object' || Array.isArray(value.moduleOverrides))) {
            throw new Error('Invalid moduleOverrides');
        }
        const moduleOverrides: Record<string, string> = {};
        for (const [source, target] of Object.entries(value.moduleOverrides || {}).sort(([a], [b]) => a.localeCompare(b))) {
            if (!/^pal\/[a-zA-Z0-9_/-]+$/.test(source) || typeof target !== 'string' || !target
                || path.isAbsolute(target) || path.win32.isAbsolute(target)
                || target.split(/[\\/]/).includes('..') || target.includes('{{')) {
                throw new Error('Invalid PAL override: ' + source);
            }
            moduleOverrides[source] = target.replace(/\\/g, '/');
        }
        const normalized: PlatformDefinition = { id: value.id, category: value.category };
        if (runtimeMode !== value.category) { normalized.runtimeMode = runtimeMode; }
        if (Object.keys(moduleOverrides).length) { normalized.moduleOverrides = moduleOverrides; }
        const previous = result.get(value.id);
        if (previous && !sameDefinition(previous, normalized)) { throw new Error('Conflicting platform: ' + value.id); }
        result.set(value.id, normalized);
    }
    return [...result.values()];
}

function parseInheritedDefinitions (): PlatformDefinition[] {
    if (!initialEnvironmentValue) { return []; }
    let parsed: unknown;
    try {
        parsed = JSON.parse(initialEnvironmentValue);
    } catch (error) {
        throw new Error(`Invalid ${ENVIRONMENT_KEY}: ${(error as Error).message}`);
    }
    return validatePlatformDefinitions(parsed as PlatformDefinition[]);
}

for (const definition of parseInheritedDefinitions()) {
    registrations.set(definition.id, { definition: freezeDefinition(definition), references: 0, inherited: true });
}

function synchronizeEnvironment (): void {
    const hasLocalRegistration = [...registrations.values()].some((entry) => entry.references > 0 || !entry.inherited);
    if (!hasLocalRegistration) {
        if (initialEnvironmentValue === undefined) { delete process.env[ENVIRONMENT_KEY]; }
        else { process.env[ENVIRONMENT_KEY] = initialEnvironmentValue; }
        return;
    }
    process.env[ENVIRONMENT_KEY] = JSON.stringify([...registrations.values()].map((entry) => entry.definition));
}

/** Register one platform. Equal repeated registrations are reference-counted. */
export function registerPlatform (value: PlatformDefinition): DisposePlatform {
    const definition = validatePlatformDefinitions([value])[0];
    let entry = registrations.get(definition.id);
    if (entry && !sameDefinition(entry.definition, definition)) {
        throw new Error('Conflicting platform: ' + definition.id);
    }
    if (!entry) {
        entry = { definition: freezeDefinition(definition), references: 0, inherited: false };
        registrations.set(definition.id, entry);
    }
    entry.references++;
    synchronizeEnvironment();
    let disposed = false;
    return function disposePlatform (): void {
        if (disposed) { return; }
        disposed = true;
        const current = registrations.get(definition.id);
        if (!current || !sameDefinition(current.definition, definition)) { return; }
        current.references = Math.max(0, current.references - 1);
        if (!current.references && !current.inherited) { registrations.delete(definition.id); }
        synchronizeEnvironment();
    };
}

/** Register multiple platforms atomically and dispose them as a group. */
export function registerPlatformDefinitions (values: readonly PlatformDefinition[]): DisposePlatform {
    const normalized = validatePlatformDefinitions(values);
    const disposers: DisposePlatform[] = [];
    try {
        for (const definition of normalized) { disposers.push(registerPlatform(definition)); }
    } catch (error) {
        for (const dispose of disposers.reverse()) { dispose(); }
        throw error;
    }
    let disposed = false;
    return function disposePlatformDefinitions (): void {
        if (disposed) { return; }
        disposed = true;
        for (const dispose of disposers.reverse()) { dispose(); }
    };
}

export function getPlatformDefinitions (): PlatformDefinition[] {
    const values = scope.getStore() || [...registrations.values()].map((entry) => entry.definition);
    return values.map(cloneDefinition);
}

export function withPlatformDefinitions<T> (values: readonly PlatformDefinition[], action: () => T): T {
    return scope.run(validatePlatformDefinitions(values).map(freezeDefinition), action);
}

export function getPlatformCategory (id: string): PlatformDefinition['category'] | undefined {
    return getPlatformDefinitions().find((item) => item.id === String(id).toUpperCase())?.category;
}

/** Feature level consumed by platform plugin hosts. */
export const platformRegistryVersion = 3;

export interface PlatformConstant {
    comment: string;
    type: 'boolean' | 'number';
    value: boolean | number | string;
    internal: boolean;
    ccGlobal?: boolean;
    dynamic?: boolean;
}

/** Shared by source builds and versioned package backports. Mutates a freshly parsed config only. */
export function extendPlatformConstants (config: Record<string, PlatformConstant>, values = getPlatformDefinitions()): void {
    for (const definition of values) {
        if (Object.prototype.hasOwnProperty.call(config, definition.id)) {
            throw new Error('Platform constant already exists: ' + definition.id);
        }
        config[definition.id] = {
            comment: 'Custom platform ' + definition.id,
            type: 'boolean',
            value: false,
            internal: false,
        };
    }
    for (const [mode, constant] of [['web', 'HTML5'], ['minigame', 'MINIGAME'], ['runtime', 'RUNTIME_BASED'], ['native', 'NATIVE']]) {
        const ids = values.filter((item) => (item.runtimeMode || item.category) === mode).map((item) => '$' + item.id);
        if (ids.length) {
            const previous = config[constant];
            config[constant] = {
                ...(previous || { comment: mode, type: 'boolean', internal: false }),
                value: '(' + String(previous ? previous.value : false) + ') || ' + ids.join(' || '),
            };
        }
    }
}

export function getPlatformModuleOverrides (engine: string, platform: string | undefined, values = getPlatformDefinitions()): Record<string, string> {
    const result: Record<string, string> = {};
    const id = String(platform || '').toUpperCase();
    const definition = values.find((item) => item.id === id);
    for (const [source, target] of Object.entries(definition?.moduleOverrides || {})) {
        result[source] = path.resolve(engine, target);
    }
    return result;
}
