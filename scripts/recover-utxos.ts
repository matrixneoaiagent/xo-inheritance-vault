import { Engine, XO_SUPPORTED_NETWORKS } from '@xo-cash/engine';
import { p2pkhTemplate } from '@xo-cash/templates';
import { mkdirSync } from 'node:fs';
import { loadWalletConfig } from './lib/config.js';

/**
 * Recovery helper: the engine derives receive/change keys from a per-template
 * counter, so a lost database makes earlier change outputs unreachable even
 * though the mnemonic is intact. This walks the same derivation sequence and
 * re-subscribes to every script until the old outputs reappear.
 *
 *   XO_DB_PATH=.xo-data-recover node --import tsx scripts/recover-utxos.ts 200
 */
const rounds = Number(process.argv[2] ?? '100');
const wallet = loadWalletConfig();
const databasePath = process.env.XO_DB_PATH ?? '.xo-data-recover';
mkdirSync(databasePath, { recursive: true });
const engine = await Engine.create(wallet.mnemonic, { network: XO_SUPPORTED_NETWORKS.chipnet, databasePath });
try {
    const { templateIdentifier } = await engine.importTemplate(p2pkhTemplate);
    await engine.setDefaultPolicies({
        receive: { templateIdentifier },
        change: { templateIdentifier },
        address: { templateIdentifier },
    });
    for (let index = 0; index < rounds; index += 1) {
        await engine.generateLockingBytecodeFromDefaultPolicy('receive');
        await engine.generateLockingBytecodeFromDefaultPolicy('change');
        if (index % 20 === 0) {
            const found = (await engine.listSpendableUnspentOutputs()).filter((utxo) => BigInt(utxo.valueSatoshis) > 50_000n);
            console.log('index', index, 'large utxos', found.length);
            if (found.length > 0) break;
        }
    }
    // Give Electrum a moment to report balances for the new subscriptions.
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const utxos = await engine.listSpendableUnspentOutputs();
    let total = 0n;
    for (const utxo of utxos) total += BigInt(utxo.valueSatoshis);
    console.log('TOTAL', String(total), 'utxos', utxos.length);
    for (const utxo of utxos.filter((candidate) => BigInt(candidate.valueSatoshis) > 50_000n)) {
        console.log('LARGE', utxo.outpointTransactionHash, utxo.outpointIndex, String(utxo.valueSatoshis));
    }
} finally {
    await engine.stop();
}
