import { Engine, XO_SUPPORTED_NETWORKS } from '@xo-cash/engine';
import { p2pkhTemplate } from '@xo-cash/templates';
import { hexToBin, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { mkdirSync } from 'node:fs';
import { loadWalletConfig } from './lib/config.js';

/**
 * Derives the beneficiary's receiving script and address from a second wallet
 * file (XO_WALLET). The private key never leaves that file; only the public
 * P2PKH script is printed, because that is the only thing the vault commits to.
 */
const wallet = loadWalletConfig(process.env.XO_WALLET);
const databasePath = process.env.XO_DB_PATH ?? '.xo-data-beneficiary';
mkdirSync(databasePath, { recursive: true });
const engine = await Engine.create(wallet.mnemonic, {
    network: XO_SUPPORTED_NETWORKS.chipnet,
    databasePath,
});
try {
    const { templateIdentifier } = await engine.importTemplate(p2pkhTemplate);
    await engine.setDefaultPolicies({
        receive: { templateIdentifier },
        change: { templateIdentifier },
        address: { templateIdentifier },
    });
    const lockingBytecode = await engine.generateLockingBytecodeFromDefaultPolicy('receive');
    const address = lockingBytecodeToCashAddress({ bytecode: hexToBin(lockingBytecode), prefix: 'bchtest' });
    if (typeof address === 'string') throw new Error(address);
    console.log('BENEFICIARY_SCRIPT', lockingBytecode);
    console.log('BENEFICIARY_ADDRESS', address.address);
} finally {
    await engine.stop();
}
