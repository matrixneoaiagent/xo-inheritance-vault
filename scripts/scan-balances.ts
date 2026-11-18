import {
    binToHex,
    deriveHdPath,
    deriveHdPrivateNodeFromBip39Mnemonic,
    encodeLockingBytecodeP2pkh,
    hash160,
    lockingBytecodeToCashAddress,
    secp256k1,
} from '@bitauth/libauth';
import { ElectrumClient } from '@electrum-cash/network';
import { createPathIndexFromHash } from '@xo-cash/crypto';
import { generateTemplateIdentifier, parseTemplate, scriptToScriptHash } from '@xo-cash/utils';
import { p2pkhTemplate } from '@xo-cash/templates';
import { loadWalletConfig } from './lib/config.js';

/** Scans the p2pkh derivation range for unspent outputs (see scan-wallet.ts). */
const wallet = loadWalletConfig();
const rounds = Number(process.argv[2] ?? '200');
const templateIdentifier = generateTemplateIdentifier(parseTemplate(p2pkhTemplate));
const templateIndex = createPathIndexFromHash(Buffer.from(templateIdentifier, 'hex'));
const master = deriveHdPrivateNodeFromBip39Mnemonic(wallet.mnemonic);
if (typeof master === 'string') throw new Error(master);

const candidates: Array<{ index: number; scriptHash: string; address: string }> = [];
for (let childIndex = 0; childIndex < rounds; childIndex += 1) {
    const node = deriveHdPath(master, `m/42415'/${templateIndex}'/0'/${childIndex}`);
    if (typeof node === 'string') throw new Error(node);
    const publicKey = secp256k1.derivePublicKeyCompressed(node.privateKey);
    if (typeof publicKey === 'string') throw new Error(publicKey);
    const script = encodeLockingBytecodeP2pkh(hash160(publicKey));
    const address = lockingBytecodeToCashAddress({ bytecode: script, prefix: 'bchtest' });
    if (typeof address === 'string') throw new Error(address);
    candidates.push({ index: childIndex, scriptHash: scriptToScriptHash(script), address: address.address });
    void binToHex(script);
}

const client = new ElectrumClient('scan', '1.4.1', 'chipnet.imaginary.cash', 50002 as unknown as never);
await client.connect();
let total = 0n;
for (const candidate of candidates) {
    try {
        const unspent = await client.request('blockchain.scripthash.listunspent', candidate.scriptHash) as Array<{ tx_hash: string; tx_pos: number; value: number }>;
        for (const output of unspent) {
            total += BigInt(output.value);
            console.log(`FOUND index=${candidate.index} ${output.tx_hash}:${output.tx_pos} ${output.value} sats ${candidate.address}`);
        }
    } catch (error) {
        console.log('query failed', candidate.index, (error as Error).message);
    }
}
console.log('TOTAL', String(total), 'over', candidates.length, 'addresses');
await client.disconnect();
