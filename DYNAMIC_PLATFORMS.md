# Dynamic engine platforms

The compiler package owns dynamic engine-platform definitions. A platform build
hook registers its macro during `load()` and releases it during `unload()`.
Builder does not read a platform manifest or forward a registry to ccbuild.

```js
let disposePlatform;

exports.load = async function load() {
    const compiler = require('@cocos/ccbuild');
    disposePlatform = compiler.registerPlatform({
        id: 'MY_RUNTIME_GAME',
        category: 'minigame',
        runtimeMode: 'runtime',
    });
};

exports.unload = async function unload() {
    disposePlatform?.();
    disposePlatform = undefined;
};
```

IDs are uppercase identifiers. Categories are `web`, `minigame`, and `native`.
The ID becomes a boolean engine macro. `runtimeMode` defaults to `category`; a
`minigame` definition with `runtimeMode: 'runtime'` contributes to
`RUNTIME_BASED`, not `MINIGAME`.

Equal repeated registrations are reference-counted. A different definition for
an active ID is rejected. The returned disposer is idempotent. Active definitions
are serialized internally so compiler child processes started after registration
restore the same registry automatically.

`moduleOverrides` may map virtual `pal/*` specifiers to engine-relative files.
Paths cannot be absolute, escape the engine with parent segments, or contain
template placeholders. Registration does not provide SDK integration, adapters,
startup templates, or platform-specific engine behavior.

`buildEngine.Options.platformDefinitions` and
`Modularize.withPlatformDefinitions()` remain compatibility APIs for an isolated
single-build scope. New platform plugins should use the hook lifecycle above.

## Verification

- `npm run build`
- `node scripts/test-platform-registry.cjs`
- Set `CCBUILD_TEST_ENGINE=1` to additionally compile the animation fixture.

The exported `platformRegistryVersion` is `3`.
