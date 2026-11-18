import { openEngine, stopEngine } from './lib/engine.js';
const { engine } = await openEngine();
try {
    for (const entry of await engine.listScriptHashes()) {
        console.log(entry.scriptHash.slice(0, 10), entry.lockingBytecode.slice(0, 16), entry.templateIdentifier.slice(0, 8), entry.lockingScriptIdentifier, entry.roleIdentifier ?? '-', (entry.secrets ?? []).join(','));
    }
} finally { await stopEngine(engine); }
