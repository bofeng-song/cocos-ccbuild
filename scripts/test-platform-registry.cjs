/* Run after `npm run build`: node scripts/test-platform-registry.cjs */
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert').strict;
const Module = require('module');
const cp = require('child_process');

const root = path.resolve(__dirname, '..');
const deps = Module.createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const environmentKey = 'COCOS_ENGINE_PLATFORM_DEFINITIONS';
const initialEnvironmentValue = process.env[environmentKey];
delete process.env[environmentKey];

const resolve = Module._resolveFilename;
Module._resolveFilename = function (name, parent, ...rest) {
    if (name.startsWith('@ccbuild/')) {
        const pkg = name.slice('@ccbuild/'.length);
        if (['modularize', 'stats-query', 'build-engine'].includes(pkg)) {
            return path.join(root, 'modules', pkg, 'src/index.ts');
        }
    }
    try {
        return resolve.call(this, name, parent, ...rest);
    } catch (error) {
        if (name.startsWith('.') || path.isAbsolute(name)) { throw error; }
        return deps.resolve(name);
    }
};

require.extensions['.ts'] = (mod, file) => {
    const result = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
        fileName: file,
        reportDiagnostics: true,
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2020,
            esModuleInterop: true,
        },
    });
    const errors = (result.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
    assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, {
        getCanonicalFileName: (fileName) => fileName,
        getCurrentDirectory: () => root,
        getNewLine: () => '\n',
    }));
    mod._compile(result.outputText, file);
};

const registry = require('../modules/modularize/src/platform-registry.ts');
const { ModuleQuery } = require('../modules/modularize/src/module-query.ts');
const { StatsQuery } = require('../modules/stats-query/src/index.ts');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbuild-platform-'));
const write = (file, value) => {
    const target = path.join(temp, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(value));
};

(async () => {
    write('package.json', { workspaces: ['pal'] });
    write('pal/package.json', {
        name: '@test/pal',
        exports: {
            '.': {
                types: './types.ts',
                web: { default: './web.ts' },
                minigame: { default: './mini.ts', CUSTOM_GAME: './wrong.ts', custom_game: './custom.ts' },
                native: './native.ts',
            },
        },
    });
    write('cc.config.json', { constants: {
        BUILD: { comment: 'fixture', type: 'boolean', value: false, internal: true },
        HTML5: { comment: 'fixture', type: 'boolean', value: false, internal: false },
        MINIGAME: { comment: 'fixture', type: 'boolean', value: false, internal: false },
        RUNTIME_BASED: { comment: 'fixture', type: 'boolean', value: false, internal: false },
        NATIVE: { comment: 'fixture', type: 'boolean', value: false, internal: false },
        WECHAT: { comment: 'fixture', type: 'boolean', value: false, internal: false },
    } });

    assert.equal(registry.platformRegistryVersion, 3);
    assert.equal(typeof registry.registerPlatform, 'function');
    assert.match(fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8'), /export \{ registerPlatform,/);
    for (const id of ['WECHAT', 'DEBUG', 'RUNTIME_BASED', 'SUPPORT_JIT']) {
        assert.throws(() => registry.registerPlatform({ id, category: 'web' }), /built-in/);
    }
    assert.throws(() => registry.registerPlatform({ id: '../BAD', category: 'web' }), /Invalid/);
    assert.throws(() => registry.validatePlatformDefinitions([
        { id: 'BAD_PATH', category: 'minigame', moduleOverrides: { 'pal/env': 1 } },
    ]), /PAL override/);

    const referenceDefinition = { id: 'REFERENCE_RUNTIME', category: 'minigame', runtimeMode: 'runtime' };
    const disposeFirst = registry.registerPlatform(referenceDefinition);
    const disposeSecond = registry.registerPlatform(referenceDefinition);
    assert.deepEqual(registry.getPlatformDefinitions(), [referenceDefinition]);
    assert.throws(() => registry.registerPlatform({ ...referenceDefinition, runtimeMode: 'minigame' }), /Conflicting/);
    disposeFirst();
    disposeFirst();
    assert.deepEqual(registry.getPlatformDefinitions(), [referenceDefinition]);
    disposeSecond();
    assert.deepEqual(registry.getPlatformDefinitions(), []);

    const keep = registry.registerPlatform({ id: 'KEEP_RUNTIME', category: 'minigame', runtimeMode: 'runtime' });
    assert.throws(() => registry.registerPlatformDefinitions([
        { id: 'ROLLBACK_RUNTIME', category: 'minigame', runtimeMode: 'runtime' },
        { id: 'KEEP_RUNTIME', category: 'minigame', runtimeMode: 'minigame' },
    ]), /Conflicting/);
    assert.deepEqual(registry.getPlatformDefinitions().map((definition) => definition.id), ['KEEP_RUNTIME']);
    keep();

    const childDefinition = { id: 'CHILD_RUNTIME', category: 'minigame', runtimeMode: 'runtime' };
    const disposeChild = registry.registerPlatform(childDefinition);
    const compiledRegistry = path.join(root, 'modules/modularize/lib/platform-registry.js');
    assert.ok(fs.existsSync(compiledRegistry), 'Run npm run build before this test');
    const childScript = 'const registry=require(process.argv[1]);process.stdout.write(JSON.stringify(registry.getPlatformDefinitions()));';
    const childValues = JSON.parse(cp.execFileSync(process.execPath, ['-e', childScript, compiledRegistry], {
        encoding: 'utf8',
        env: process.env,
    }));
    assert.deepEqual(childValues, [childDefinition]);
    disposeChild();
    assert.equal(process.env[environmentKey], undefined);

    const definitions = [
        { id: 'CUSTOM_GAME', category: 'minigame', runtimeMode: 'minigame' },
        { id: 'CUSTOM_RUNTIME', category: 'minigame', runtimeMode: 'runtime', moduleOverrides: { 'pal/minigame': 'pal/minigame/runtime.js' } },
        { id: 'CUSTOM_WEB', category: 'web', runtimeMode: 'web' },
        { id: 'CUSTOM_NATIVE', category: 'native', runtimeMode: 'native' },
    ];
    await registry.withPlatformDefinitions(definitions, async () => {
        for (const [platform, category] of [
            ['CUSTOM_GAME', 'MINIGAME'],
            ['CUSTOM_RUNTIME', 'RUNTIME_BASED'],
            ['CUSTOM_WEB', 'HTML5'],
            ['CUSTOM_NATIVE', 'NATIVE'],
        ]) {
            const manager = new StatsQuery.ConstantManager(temp);
            const values = manager.genCCEnvConstants({ platform, mode: 'BUILD', flags: {} });
            assert.equal(values[platform], true);
            assert.equal(values[category], true);
            if (platform === 'CUSTOM_RUNTIME') { assert.equal(values.MINIGAME, false); }
            assert.match(manager.genCCEnv(), new RegExp(platform));
        }
        assert.equal(path.basename(await new ModuleQuery({ engine: temp, platform: 'CUSTOM_GAME' }).resolveExport('@test/pal')), 'custom.ts');
        const query = await StatsQuery.create(path.join(root, 'test/test-engine-source'));
        const overrides = query.evaluateModuleOverrides({ platform: 'custom_runtime', buildTimeConstants: {} });
        assert.equal(overrides['pal/minigame'], path.resolve(root, 'test/test-engine-source/pal/minigame/runtime.js'));
    });
    assert.deepEqual(registry.getPlatformDefinitions(), []);

    await Promise.all(definitions.slice(0, 2).map((definition) => registry.withPlatformDefinitions([definition], async () => {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
        assert.deepEqual(registry.getPlatformDefinitions(), registry.validatePlatformDefinitions([definition]));
    })));

    if (process.env.CCBUILD_TEST_ENGINE === '1') {
        const { buildEngine } = require('../modules/build-engine/src/index.ts');
        const result = await buildEngine({
            engine: path.join(root, 'test/test-engine-source'),
            out: path.join(temp, 'engine-output'),
            features: ['animation'],
            platform: 'CUSTOM_GAME',
            platformDefinitions: definitions,
            mode: 'BUILD',
            moduleFormat: 'esm',
            compress: false,
            split: false,
        });
        assert.ok(Object.keys(result.exports).length);
    }

    console.log('PASS: registry v3 lifecycle, rollback, child propagation, runtime modes and query isolation');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    if (initialEnvironmentValue === undefined) { delete process.env[environmentKey]; }
    else { process.env[environmentKey] = initialEnvironmentValue; }
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith('ccbuild-platform-'));
    fs.rmSync(temp, { recursive: true, force: true });
});
