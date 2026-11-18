import { openEngine, stopEngine } from './lib/engine.js';
const { engine, templateIdentifier } = await openEngine();
try {
    const utxos = await engine.listSpendableUnspentOutputs();
    console.log('vault template', templateIdentifier);
    for (const utxo of utxos) {
        console.log(`${utxo.outpointTransactionHash.slice(0, 12)}:${utxo.outpointIndex}`, String(utxo.valueSatoshis), utxo.templateIdentifier.slice(0, 8), utxo.scriptHash.slice(0, 8), utxo.minedAtHeight ?? '?');
    }
} finally {
    await stopEngine(engine);
}
