# Feedback on building with XO

> **Scaffold, not a submission.** The heading and the bullets below are factual
> prompts from this build so the prose can be written by hand (the bounty
> rejects AI-written feedback). Replace each bullet with your own sentences:
> what you expected, what happened, what you would change. Numbers, file names
> and error strings are here so you never have to guess; `docs/FINDINGS.md` has
> the reproductions.

## What worked well

- Templates are a real abstraction, not a wrapper: the same five actions ran
  unchanged through the engine, the debug tool and the CLI scripts.
- One `.ts` file described the whole contract; the address was a deterministic
  hash of it, so `parseTemplate` → `generateTemplateIdentifier` and
  `Engine.importTemplate` agreed on the first try.
- `createVault` needed no hand-written covenant assembly: roles, required
  variables and secrets were enough to build, sign and broadcast.
- The identity of a covenant is inspectable: `resolveInvitationOutputLockingBytecode`
  returned exactly the bytecode my own recompilation produced (257-byte redeem,
  P2SH32 `aa209efae8…ec87`). That check is now a gate in `scripts/create.ts`.
- The debug tool rendered every action type — including the rejected early claim
  — without complaint, and showed the role, the commits and the invitation id.
- `executeAction` is deterministic: the retry loop re-sent the *same* txid
  (`bf9fa850…`) instead of rebuilding a different transaction.
- The separated `unlock*` scripts made "one covenant, four functions" easy to
  express, including a branch that needs no key at all.

## Where I got stuck

- `<0>` and `signInvitation` for a signature-free spend (FINDINGS 1): how long
  did you spend on `Tried to read from an empty stack` before finding it?
- A second wallet cannot build a claim on a covenant it does not track
  (FINDINGS 2). What did you expect `createInvitation({inputs})` to do? What
  would make a "watch this address" flow natural (a rescan API, an input
  carrying its own locking bytecode, a shareable watch-only invitation)?
- Spend-time values vs address commitment (FINDINGS 3): the compiler error
  `Missing required variable: ownerPayoutLockingScript, nextVaultLockingScript`
  was correct but arrived only after the design was written. How should a
  template express "this output must be a covenant built from these values"?
- Recomputing a covenant yourself (FINDINGS 4): thirty lines of
  `compileCashAssemblyString` + `hash256` should be one engine call.
- Chipnet's BIP68 behaviour (FINDINGS 5): twenty blocks and eighteen minutes of
  `non-BIP68-final` for a coin every server called old. How did the sequence
  sweep (0,1,2 pass the lock check, 3 fails) change your mental model? Should
  the engine surface the node's lock-point calculation?
- Losing change by recreating the account database (FINDINGS 10): how much did
  the manual re-derivation cost, and what should `rescan` look like?
- `minedAtHeight` returning 0 and the permanent header-sync errors
  (FINDINGS 11): how much debugging time went into ignoring log noise?

## Suggestions, ranked by value to me

1. `engine.compileLockingScript({ templateIdentifier, lockingScriptIdentifier, variables })`.
2. `engine.rescan({ templateIdentifier, toIndex })` (or a persistent derivation counter).
3. Compile the unlocking script when an invitation is complete, so
   signature-free actions do not need `signInvitation()`.
4. A first-class way to reference another covenant (recursive template
   reference) for vault chains.
5. A `text` variable type, or reject bare strings for `bytes` (FINDINGS 7).
6. Expose template `constants` inside compiled scripts (FINDINGS 8).
7. Honour `selectable: false` for Electrum-ingested UTXOs (FINDINGS 12).

## What was missing from the docs

- "One account per process" is mentioned, but not what happens if two engines
  share a database, or how to run an owner and a beneficiary side by side.
- Nothing explains that a template's `unlockingBytecode` is only materialised
  on signing, or what a claim-style action is supposed to look like.
- The debug tool's "import the template first" requirement is undocumented on
  the landing page (FINDINGS 13).
- No guidance on relative locktime (BIP68/CSV) at all: no example, no note that
  `nSequence` must come from the invitation and not the template.

## Honest summary

- The stack is usable for a real, non-trivial covenant: I shipped a dead-man's
  switch with four branches, a signed renewal, an unsigned claim and two owner
  escape hatches, on Chipnet, in one evening.
- Everything that failed was either a missing API (compile/rescan/track) or
  Chipnet's own BIP68 behaviour — not an unsolvable design problem.
- The two things I would fix first are the silent empty unlocking script and the
  inability of a third party to spend a covenant they do not track, because both
  turn "no custodian" into "no custodian, but bring the owner's database".
