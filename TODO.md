# TODO — JVC Projector v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm audit --omit=dev`,
  `npx github:GladysAssistant/integration-store .`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only.

## Status

- [x] **Milestone 1 — local control** (2026-10-20): projectors added by IP
      address, identified by MAC address; one short TCP session per round and
      per command; power state and status, Power on / Standby buttons, input,
      picture mode, remote keys, signal, lamp hours; optional network
      password; "Check the projectors" button; docs en/fr. Tested against a
      fake projector on the loopback interface only, never with a real
      projector. The store validator could not be run from the development
      session (no access to it there): to run before the first release.
- [ ] **Milestone 2 — real projectors** (testers with an NZ, NX, N or X
      model). To check first:
  - whether `MD` and `LSMA` answer in standby (network standby, ECO off), and
    the exact form of the `LSMA` answer;
  - what the projector answers to an operation it refuses (Power on while
    cooling down, an input change in standby): no ack, or an ack and
    nothing done; today the power state read before decides, and a missing
    ack is "sent, without confirmation";
  - whether closing the socket before the late ack of an input change
    harms (today the ack is awaited up to 10 s, holding the queue);
  - the handshake of a projector with another client connected (`PJ_NG`, or
    a closed socket: both read as "busy");
  - the password forms on the 2024+ models (plain then SHA-256 on the same
    connection, as pyjvcprojector);
  - the rendering on the Gladys dashboard (not checked here): the two
    `button/push`, the `unknown/binary` power and signal, the `text/text`
    status, the three `text/select`, the `duration` hours.
- [ ] **Milestone 3 — more**: laser power, lens memory (`INML`), anamorphic,
      HDR processing, low latency (the commands exist in pyjvcprojector), one
      password per projector, a "forget a projector" action.
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, then the store validator once the image is published.

## Decisions

- Forum: no dedicated topic, no post from this module's work; one recap per
  wave in /t/10385, posted by the main session.
- Reuse: SteveEasley/pyjvcprojector 2.1.0 (MIT, tag `v2.1.0` of 2026-10-12,
  the library of the Home Assistant JVC Projector integration; LICENSE file
  read: MIT, copyright 2021 Steve Easley) is Python (asyncio), so its
  protocol, handshake, timings, specifications and value maps are ported to
  JavaScript (`src/jvc/`); MIT notice in `THIRD_PARTY_NOTICES.md`, copied
  into the image. The Home Assistant integration was read for the identity
  (MAC address), the reads made while on and the remote keys. No runtime
  dependency besides the SDK (`node:net`, `node:crypto`).
- Version 0.1.0 in `package.json`, `package-lock.json`, the manifest and the
  `docker_image` tag, set by hand at milestone 1: the one exception to
  "versions belong to the Release workflow", because the template's 1.0.0 and
  its image were someone else's. The first patch release gives 0.1.1.
- External ids: `gladys.externalIds('projector', <mac>)`, the MAC of `LSMA`
  as 12 lowercase hex digits (Home Assistant uses the MAC as unique id),
  never the address. Feature keys are frozen: `power`, `power_status`,
  `power_on`, `standby`, `input`, `picture_mode`, `remote_key`, `signal`,
  `light_time`. Every publication carries the full, fixed feature list; only
  the picture mode options grow (merged with the `supported_options` of the
  created device).
- **Power: read-only state + two `button/push` ("Power on", "Standby"), not
  a `switch`** (lesson of lot 6; asked again for this module): an
  "everything off / on" must never reach a projector. `power` is
  `unknown/binary`, 1 on or warming up, 0 standby, cooling down, error or not
  reachable; `power_status` (`text/text`) tells them apart, in English (a
  text state has one language; translated in docs/fr.md).
- Power on: the power read just before (1.5 s at most) decides: standby →
  `PW1`; on or warming up → nothing; cooling down → refused "nothing sent"
  (the projector refuses it); error or unknown → refused.
- Standby: the protective command, never blocked. On (or error) → `PW0`;
  standby or cooling down → nothing; warming up → deferred: a check every
  5 s (through the queue), sent once on, dropped after 3 minutes or when
  the projector is back in standby; a Power on press cancels it (the
  "cancel the pending opposite command" rule). An unread state (timeout,
  busy at the handshake) does not refuse it: `PW0` is sent in a new
  session if the budget allows. Standby goes before the commands waiting.
- Input, picture mode, remote key: sent only when the power read just before
  is on. Input `IP6` / `IP7` (HDMI 1 / 2, the only ones pyjvcprojector
  maps); picture mode codes per specification and model (pyjvcprojector's
  maps, model-only entries kept to their models; "reserved" and the CS20141
  read-only "4k" never offered); remote keys the list Home Assistant offers.
- Commands: validated before queueing (no connection for an invalid one),
  serialized per address, budget 3.5 s from the Gladys request (wait in the
  queue included); a command still queued at its deadline is dropped,
  never sent late. An operation frame that left is "sent, without
  confirmation" when its ack does not come in time; the ack of an input or
  picture mode change is still awaited up to 10 s (pyjvcprojector's
  operation timeout), holding the queue, then the socket is closed. The
  state is read again 3 s after each command.
- Sessions: one per round and per command, closed at the end (no
  keep-alive); connections 0.75 s apart, commands 0.1 s after a read and
  1 s after an operation (pyjvcprojector's spacing). `PJ_NG`, or a socket
  closed during the handshake, is "busy": nothing published, the command
  "nothing sent". Connection refused / no answer: "not reachable", power 0.
- Password: one `secret` field for all the projectors, optional. Sent as
  pyjvcprojector does: `PJREQ_` + the password padded with NUL bytes to 16
  bytes, then, on `PJNAK`, `PJREQ_` + SHA-256 hex of password + `JVCKWPJ` on
  the same connection; the form that worked is tried first next time (kept
  in memory only: the SHA-256 form is as good as the password). Never
  logged, never in `/data`, statuses, errors or device params (tested).
  Described as "kept by Gladys in its database, never shown again" (never
  "encrypted"). A password with control characters or more than 64
  characters is not sent (said in the status, without its value).
- Refused password: `/data` keeps `authRefused[<address>] = retryAt` (now +
  30 minutes, capped at 30 minutes when read back); no session to that
  address before it (rounds, probes, commands: "password refused, nothing
  sent"), the status is `connected: false` with the message until a try
  succeeds. A configuration save clears every refusal (it may hold a new
  password) and the remembered forms; a reconnection to Gladys does not.
- Polling: `poll_interval` 10..300 s (15 by default), one read per created
  projector and round, never faster (a typed address not answering yet:
  every minute at most). Power always; when on: signal, input, lamp time;
  the picture mode with a signal only (as Home Assistant). A secondary read
  that fails never drops the power state; an unknown answer keeps what was
  known. When a projector comes back (first read, or after "not
  reachable"), its MAC is read first: another projector at that address
  clears the old one's address (DHCP), never commanded there.
- `connected` (reconnection to Gladys): status cache and
  `forgetPublishedStates` cleared, devices, states (from memory) and status
  published again; the projectors are not asked because of it. A
  configuration save polls at once.
- Units: `hours` for `duration/integer` (in
  `DEVICE_FEATURE_UNITS_BY_CATEGORY` for `duration`); no unit for the other
  categories (`button`, `unknown`, `text`). Store category `multimedia`.
- Hostile input: 512 bytes buffered at most (else the socket is closed), a
  5-byte handshake, answers as single lines matched against
  `@ 0x89 0x01 <code>`, printable ASCII values of 64 characters at most,
  mapped through fixed tables (`Object.hasOwn`); `/data` keys are MAC
  addresses only, the tables have no prototype; picture options are plain
  identifiers.
- (Review 1, 2026-10-21) Fixes:
  - I1: each queue knows the session open on its address
    (`activeSessions`); a standby (or the deferred standby) entering the
    queue closes it when it is preemptible: a background read, or an input /
    picture mode change whose frame left and that only waits for its slow
    ack (that command stays "sent, without confirmation").
  - I2: one timer per deferred entry (`entry.timer`): reads from rounds,
    rechecks or device creation never add a chain.
  - I3: a failed read (unknown) keeps the deferred standby and asks again
    after `deferredStep`, until its 3 minutes; standby, cooling down, error
    or not reachable drop it.
  - I4: once a `PJNAK` was received, any end of the handshake (closed,
    silence, garbage) is AUTH, so persisted by `markAuthRefused`.
  - I5: `LSMA` is read at the start of every background read (one more
    request, ~0.1 s) and before every command, with the power, within
    `preRead`; another MAC clears the address, publishes "Not reachable"
    and answers "nothing sent". A standby whose MAC and power could not be
    read is still sent blind (the protective command, as before).
  - M1: the round timer is only recreated when `poll_interval` changes.
    M2: one shared load of `/data`. M3: all-zero, broadcast and multicast
    MACs are refused. M4: a deferred standby answers Gladys an error saying
    "standby will be sent once it is on, nothing sent yet" (exact, not a
    success). M5: refusals of addresses neither typed nor of a created
    projector are purged at each status update.
- (Review 2, 2026-10-21) Fixes:
  - R1: only a valid MAC different from the projector's proves another
    projector; an unreadable, refused (zeros, broadcast, multicast) or
    unanswered `LSMA` is no proof (one warning per projector and power
    state). Background reads: `PW` first, then `LSMA` read softly, so a
    silent `LSMA` never loses the power state. Commands: `LSMA` is read
    after `PW` only when this projector answered it before in that power
    state (`macReadable`, memory only); if it then does not answer, the
    state is forgotten and the command is tried again at once in a new
    session without it: a silent `LSMA` never prevents Power on. Known
    limit: in a power state where the MAC never answered, the identity
    rests on the last background read (one interval at most).
  - R2: probes and "Check the projectors" sessions are preemptible by a
    standby, as the background reads.
  - R3: after a `PJNAK`, only a closed socket, garbage or a full
    `readTimeout` silence is a refusal; a read cut short by the caller's
    budget is a timeout (no 30-minute stop).
- No network discovery: JVC projectors announce nothing pyjvcprojector or
  Home Assistant browses; the addresses are typed.
