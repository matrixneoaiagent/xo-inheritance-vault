import { readFileSync } from 'node:fs';
import { ElectrumClient } from '@electrum-cash/network';
import { requireEnv } from './lib/config.js';

/**
 * Last-resort broadcaster for a transaction the engine already built.
 *
 * The engine submits through an Electrum server; when that server's node is
 * behind on BIP68 bookkeeping it answers `non-BIP68-final` for a transaction
 * the network accepts minutes later (docs/FINDINGS.md 5). This submits the
 * exact same bytes to every configured server and reports what each one said,
 * so a relative-locktime spend can be placed without rebuilding it.
 *
 *   RAW_TX_FILE=/tmp/claim.hex EXPECTED_TXID=<txid> \
 *   node --import tsx scripts/broadcast-raw.ts
 */
const raw = readFileSync(requireEnv('RAW_TX_FILE'), 'utf8').trim();
const expected = requireEnv('EXPECTED_TXID').toLowerCase();
const hosts = (process.env.ELECTRUM_HOSTS ?? 'chipnet.imaginary.cash,chipnet.bch.ninja').split(',');

for (const host of hosts) {
    const client = new ElectrumClient('xo-inheritance-vault', '1.4.1', host);
    try {
        await client.connect();
        const tip = await client.request('blockchain.headers.subscribe') as { height: number };
        let result: unknown;
        try {
            result = await client.request('blockchain.transaction.broadcast', raw);
        } catch (error) {
            result = error;
        }
        // NOTE: this client can resolve with an Error object instead of throwing,
        // so a bare `await` looks like success. Compare the returned hash.
        const accepted = typeof result === 'string' && result.toLowerCase() === expected;
        const message = accepted ? result : String((result as Error)?.message ?? result).replace(/\s+/g, ' ').slice(0, 120);
        console.log(host, 'tip', tip.height, accepted ? 'ACCEPTED' : 'REJECTED', message);
    } catch (error) {
        console.log(host, 'CONNECT_ERROR', (error as Error).message);
    } finally {
        await client.disconnect().catch(() => undefined);
    }
}
