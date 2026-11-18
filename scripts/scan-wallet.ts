import {
    binToHex,
    deriveHdPath,
    deriveHdPrivateNodeFromBip39Mnemonic,
    encodeLockingBytecodeP2pkh,
    hash160,
    lockingBytecodeToCashAddress,
    secp256k1,
} from '@bitauth/libauth';
import { createPathIndexFromHash } from '@xo-cash/crypto';
import { generateTemplateIdentifier, parseTemplate, scriptToScriptHash } from '@xo-cash/utils';
import { p2pkhTemplate } from '@xo-cash/templates';
import { loadWalletConfig } from './lib/config.js';

/**
 * Derivation audit. XO derives every template key at
 *
 *   m/42415'/{templateIndex}'/{useCaseIndex}'/{childIndex}
 *
 * so the p2pkh receive/change scripts of an account can be rebuilt from the
 * mnemonic alone. This prints `<purpose> <index> <script> <electrumScriptHash>
 * <address>` for the first N children, which is how this repository recovered
 * change outputs after an account database was lost (FINDINGS 11).
 */
const wallet = loadWalletConfig();
const rounds = Number(process.argv[2] ?? '200');
const templateIdentifier = generateTemplateIdentifier(parseTemplate(p2pkhTemplate));
const templateIndex = createPathIndexFromHash(Buffer.from(templateIdentifier, 'hex'));
const master = deriveHdPrivateNodeFromBip39Mnemonic(wallet.mnemonic);
if (typeof master === 'string') throw new Error(master);

for (const purpose of [42415, 2415]) {
    for (let childIndex = 0; childIndex < rounds; childIndex += 1) {
        const node = deriveHdPath(master, `m/${purpose}'/${templateIndex}'/0'/${childIndex}`);
        if (typeof node === 'string') throw new Error(node);
        const publicKey = secp256k1.derivePublicKeyCompressed(node.privateKey);
        if (typeof publicKey === 'string') throw new Error(publicKey);
        const script = encodeLockingBytecodeP2pkh(hash160(publicKey));
        const address = lockingBytecodeToCashAddress({ bytecode: script, prefix: 'bchtest' });
        if (typeof address === 'string') throw new Error(address);
        console.log([`m/${purpose}'`, childIndex, binToHex(script), scriptToScriptHash(script), address.address].join(' '));
    }
}
