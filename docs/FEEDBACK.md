# Feedback on building with XO

It took me just one evening to create a four-branched dead man's switch on Chipnet using XO — from scratch to a working prototype, complete with signed extensions, two escape hatches for the owner, and an unsigned beneficiary claim. The basic abstraction is truly reliable, even if a few missing APIs and non-standard solutions made the last mile more difficult than expected.

## What worked well

The template model looks like a real abstraction of the contract, rather than a thin wrapper. Having the entire contract in one `.ts` file, where the address is a deterministic hash of the template itself, meant that `parseTemplate` → `generateTemplateIdentifier` and `Engine.importTemplate` agreed on the very first run. Exactly the same five actions ran in the engine, my CLI scripts, and the debugging tool without translation layers.

Creating a vault with `createVault` did not require handwritten assembly of a covenant — transferring roles, variables, and secrets was enough to create, sign, and broadcast. The ability to independently verify the authenticity of the covenant was also encouraging: `resolveInvitationOutputLockingBytecode` returned the exact 257-byte redeem script and the P2SH32 address (`aa209efae8…ec87`) that my manual recompilation produced, which became an automatic check in `scripts/create.ts`. The `unlock*` branch separation preserved the ability to read a four-branch contract, and `executeAction` turned out to be reliably deterministic — when the retry cycle started, it rebroadcast exactly the same txid (`bf9fa850…`) instead of creating conflicting requests. Even the debugging tool handled all action types out of the box, including rejected early claims, clearly displaying roles and commits.

## What I got stuck on

My biggest disagreement came from the engine's implicit assumptions about signatures and wallet state. First, creating an unsigned spend branch took too much debugging time on `Tried to read from an empty stack`. It turns out that the engine only compiles `unlockingBytecode` inside `signInvitation()`, so an unsigned action is automatically left empty unless you know to call `signInvitation()` anyway. Second, a separate recipient's wallet cannot build a claim on a covenant that it does not yet track locally. I assumed that passing `{inputs}` to `createInvitation` would carry enough context, whereas right now you really need an owner-side database or an import/re-scan mechanism just to browse.

Connecting vaults together also required manual plumbing. Hitting `Missing required variable: ownerPayoutLockingScript, nextVaultLockingScript` after designing the upgrade path made sense in hindsight, but it took about 30 lines of manual `compileCashAssemblyString` and `hash256` work to ensure the output was accounted for in the child covenant. On top of that, the BIP68 blocking point on Chipnet kept rejecting a spend as `non-BIP68-final` for twenty blocks (~18 minutes) even though the servers reported the coin as old enough; a sequence sweep (where 0, 1 and 2 passed and 3 failed) clarified the MTP node math, but doing that calculation first would have saved hours. Finally, re-creating the local account database destroyed the change output and required manual re-output, and `minedAtHeight` returning `0` together with constant header-sync errors caused a lot of false positives in the log.

## What could make the most difference

If I were prioritizing changes, I would start with two fixes that currently undermine trustless multi-user flows: compile the unlock script as soon as all variables are specified in the invitation (so no `signInvitation()` is required for unsigned actions), and let third-party wallets track or spend covenants without sharing the creator's state — ideally with `engine.rescan({templateIdentifier, toIndex})` or standalone input descriptors.

Immediately after that, `engine.compileLockingScript({templateIdentifier, lockingScriptIdentifier, variables})` — or native recursive references to covenants — would eliminate manual assembly when creating storage chains. Lesser quality-of-life improvements would be a `text` type variable (or dropping raw strings in favour of `bytes`), exposing template `constants` inside scripts, and honouring `selectable: false` in the Electrum UTXO list.

## Documentation gaps worth filling

A few brief notes would have saved most of my workarounds: how to run two participants (owner and beneficiary) side by side under the "one account per process" rule; a statement that `unlockingBytecode` is generated during signing; a note on the debugging tool landing page that the template must be imported first; and a short BIP68/CSV example showing that `nSequence` refers to the invitation, not the template.

In general, the breakdown was not a fundamental design flaw — it simply lacked auxiliary APIs and Chipnet documentation. Fix the automatic unlock script and third-party UTXO tracking, and the promise of "no keeper" will be fully justified in practice.
