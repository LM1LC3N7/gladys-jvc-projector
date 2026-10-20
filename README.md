# gladys-jvc-projector

[Gladys Assistant](https://gladysassistant.com) external integration for
**JVC D-ILA projectors** (DLA-NZ, NX, N, X, RS, Z series), on the local
network: power on and standby (buttons, never a switch), input, picture mode,
remote keys, signal and lamp / laser hours, through the network protocol
published by JVC (TCP 20554), without any cloud. Unofficial, not affiliated
with JVCKENWOOD.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

> **Work in progress.** First milestone, tested against a fake projector
> only, never with a real JVC projector.

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (JvcApp)
                                   ├─ src/jvc/client.js    one TCP session: handshake, password, ref / op commands (ported)
                                   ├─ src/jvc/protocol.js  frames, answers, models, picture modes, remote keys (ported, pure)
                                   ├─ src/model.js         known projectors -> Gladys devices and states (pure)
                                   └─ src/store.js         /data/jvc-projector.json: projectors, refused passwords
```

- **Projectors** are added by IP address (configuration; no network
  discovery). Each one is identified by its MAC address (`LSMA`, as Home
  Assistant): external id `projector:<mac>`. Its model (`MD`) gives the
  picture modes it offers (the specifications of pyjvcprojector).
- **One short session per round and per command** (the projector takes one
  client): `PJ_OK`, `PJREQ` with the optional password (padded plain form,
  then SHA-256 form, as pyjvcprojector), `PJACK`. Connections at least 0.75 s
  apart, commands 0.1 s after a read and 1 s after an operation. Each round
  reads the power, then, when on, signal, input, lamp time, and the picture
  mode with a signal.
- **Commands**: validated first, serialized per address (standby first,
  then the other commands, then the background reads), each within a 3.5 s
  budget (Gladys acks in 5 s), the power state read again just before.
  Power on only from standby, standby only when on (deferred while warming
  up, cancelled by Power on; never refused because of an unread state). An
  operation that may have reached the projector is reported "sent, without
  confirmation".
- **Password**: a `secret` field kept by Gladys, sent only to the
  projectors, never logged nor written to `/data`. A refused password is
  persisted per address with its retry time (30 minutes, capped when read
  back), cleared by a configuration save; never tried in a loop.
- **Features**: `button/push` (power on, standby), read-only
  `unknown/binary` power and signal, `text/text` power status, `text/select`
  input, picture mode and remote key, `duration/integer` lamp time in
  `hours` (a unit the core lists for `duration`). No switch.
- **Bounded input**: 512 bytes buffered at most, a 5-byte handshake, one line
  per answer matched against the expected header, printable values of 64
  characters at most; MAC keys only in `/data`, tables without prototype.

## Development

```bash
npm install
npm test                                        # node --test, loopback only (fake projector)
npm run lint && npm run format:check
npm run audit
npm run cover                                   # regenerates cover.png (800×534, no dependency)
npx github:GladysAssistant/integration-store .  # store admission checks
```

`test/fixtures/fakeProjector.js` is a fake JVC projector on 127.0.0.1 (the
handshake with or without password, power cycle through warming up and
cooling down, busy, silent, late or missing acks). The end-to-end tests run
the real handlers against the SDK's fake Gladys.

## Credits

- [`pyjvcprojector`](https://github.com/SteveEasley/pyjvcprojector) 2.1.0 by
  Steve Easley (MIT), the library behind the Home Assistant JVC Projector
  integration: the protocol, handshake, timings, model specifications and
  value maps are ported from it to JavaScript.
- The Home Assistant JVC Projector integration (Apache-2.0) was consulted for
  the identity (MAC address), the reads made while on and the remote keys.
- The app structure follows
  [LM1LC3N7/gladys-cambridge-audio](https://github.com/LM1LC3N7/gladys-cambridge-audio)
  and
  [LM1LC3N7/gladys-panasonic-viera](https://github.com/LM1LC3N7/gladys-panasonic-viera)
  (same author, Apache-2.0).

JVC and D-ILA are trademarks of their owner (JVCKENWOOD Corporation), used
here only to name the compatible products.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release. The
`gladys-assistant-integration` topic is added at the first real release.

## License

Apache-2.0, see [LICENSE](LICENSE). Third-party notices (pyjvcprojector,
MIT): [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
