# Final Chipnet run — artifact index

Everything here was produced by the scripts in `scripts/` against Chipnet on
2026-11-18. Invitations are public data (signed commits, outpoints, variables);
no file contains a mnemonic or a private key.

| File | What it is |
|---|---|
| `1-create-A.log` | create vault A (60,000 sat, period 3, label `for-alice-2026`), tx `ffa94121…` |
| `2-create-B.log` | create vault B (40,000 sat, period 100,000), tx `98b5a2a8…` |
| `3-poke-A.log` | poke vault A (age reset), tx `be25cd7c…` |
| `4-reject-early-claim-B.log` | early-claim negative test: script-level rejection + `non-BIP68-final` |
| `5-claim-A-engine-retries.log` | the engine's broadcast attempts for the claim, all rejected while the node was behind |
| `5a-claim-A-beneficiary-engine.log` | a beneficiary wallet cannot *build* the claim (FINDINGS 2) |
| `5b-claim-A-build.log` | the claim assembled by the owner's wallet: 261-byte unlocking script, no signature |
| `5c`, `5d`, `5e` | handing the invitation to the beneficiary's wallet and executing it |
| `5f-claim-A-accepted.log` | the exact bytes accepted at tip 337174; claim confirmed in block 337175 |
| `6-update-beneficiary-B.log` | updateBeneficiary B → B′, tx `225f71fc…` |
| `7-reclaim-B.log` | reclaim of B′ fails: the new vault script is not tracked (FINDINGS 9) |
| `8-create-C.log` | create vault C (30,000 sat, period 100,000), tx `9e8fec49…` |
| `9-reclaim-C.log` | owner reclaims C at 0-conf, ignoring the period, tx `9e144216…` |
| `10-verify-findings.log` | `scripts/verify-findings.ts` output for FINDINGS 6, 7, 8, 12, 14 |
| `11`, `12` | the period-1 vault D used for the second BIP68 probe (FINDINGS 5) |
| `*-invitation.json` | the invitation for each action, as used or as the negative test |
| `vault-A/B/C/D.json` | vault records: address, covenant bytecode, outpoint, history |
| `claim-too-early-B-reason.txt` | both rejection messages, side by side |
