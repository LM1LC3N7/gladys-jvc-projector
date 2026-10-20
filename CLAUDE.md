# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for JVC D-ILA projectors (local
network protocol published by JVC, TCP 20554, optional network password): a
Node.js service (Node 22+, ESM, no build step) that runs in its own sandboxed
Docker container and talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.
See `TODO.md` for the status and the decisions.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "standby" # tests whose name matches
npm run cover                             # regenerate cover.png (800×534)
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: src/handlers.js registered before connect()
src/handlers.js                   the SDK handlers -> JvcApp (shared with the tests)
src/app.js                        JvcApp: known projectors, polling, commands, password refusals, status
src/jvc/client.js                 one TCP session: handshake, password, ref / op commands, bounded reads
src/jvc/protocol.js               frames, answers, models, picture modes, remote keys (pure, ported)
src/model.js                      known projectors -> Gladys devices and states (pure)
src/store.js                      /data/jvc-projector.json (projectors, refused passwords; never the password)
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/constants.js, src/i18n.js     frozen keys, limits, timings; texts in English and French
scripts/cover.mjs                 cover.png generator (plain Node)
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys and a fake projector (loopback)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the MAC address
  of the projector (12 lowercase hex digits), never its address or a label.
  The same goes for every key users store: manifest `config_schema`,
  `actions`, feature keys. A device published again carries the full, fixed
  feature list: never remove a feature.
- **No switch.** Power on and standby are `button/push`; the power state is
  read only. An "everything off" must never reach a projector.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. **Never log, store or echo the password** (nor its
  padded or SHA-256 form): not in logs, `/data`, statuses, error messages or
  device params. A `secret` field is kept by Gladys in its database, never
  shown again: never write that it is "encrypted".
- **A refused password is never sent in a loop**: one stop per address,
  persisted, retried after 30 minutes or at a configuration save.
- **Commands**: validated before queueing; the power state read from the
  projector just before acting, never decided on a state in memory; the
  answer to Gladys within the 3.5 s budget; "sent, without confirmation"
  when a frame may have left, "nothing sent" otherwise. Standby is never
  blocked by an unread state and goes before the commands waiting.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`.
  The catalog `description` holds 10 to 100 characters per language.
  `test/manifest.test.js` ties the manifest to the code: change both sides
  together.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (loopback only).
- **Encoding.** Every file is UTF-8 without BOM; `test/encoding.test.js`
  refuses mojibake in the manifest, the docs and these files.
- **Untrusted input.** Everything the projector sends is bounded and checked
  against the expected header; values are mapped through fixed tables.
