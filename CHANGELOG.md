# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- JVC D-ILA projectors over their local network protocol (TCP 20554), without
  any cloud: added by IP address, identified by their MAC address, their
  model giving the picture modes offered.
- Power state (read only) and power status (On, Warming up, Cooling down,
  Standby, Error, Not reachable), "Power on" and "Standby" buttons (no
  switch), input (HDMI 1, HDMI 2), picture mode, remote keys, signal, and
  lamp / laser hours.
- Power on is sent from standby only, standby when on only; a standby asked
  while warming up is sent once the projector is on (Power on cancels it),
  and standby goes before the commands waiting. Every command is answered to
  Gladys within 4 seconds: "sent, without confirmation" when it may have
  reached the projector, "nothing sent" otherwise.
- Optional network password of the projectors (padded plain form, then
  SHA-256 form), never logged nor written to `/data`; a refused password
  stops the tries until the configuration is saved again or 30 minutes have
  passed.
- "Check the projectors" button; refresh interval option (15 s by default).

### Fixed

- Standby no longer waits behind the slow confirmation of an input or
  picture mode change, nor behind a background read: that connection is
  closed and standby goes out at once.
- A standby deferred during the warm-up keeps a single check chain (the
  rounds no longer add one each), survives a failed read, and is answered
  "warming up: standby will be sent once it is on, nothing sent yet" instead
  of a plain success.
- A password refusal followed by a closed connection or silence counts as a
  refusal (persisted, never sent again before 30 minutes), not as "busy".
- The MAC address is read at every background read and before every
  command: a projector whose address went to another one is never read nor
  commanded there.
- A MAC address unreadable, all zeros or unanswered (in standby, for
  example) no longer passes for another projector: the address is kept, the
  power state still published and Power on still sent. Only a valid,
  different MAC clears the address. The power is read before the MAC.
- A standby no longer waits behind a probe or "Check the projectors".
- A handshake cut short by the command budget after a password refusal is
  no longer recorded as a refused password.
- Reconnections to Gladys no longer restart the round timer; two starts at
  once load `/data` once; an all-zero, broadcast or multicast MAC is no
  identity; a refused password for an address no longer in use no longer
  keeps the integration disconnected.

### Security

- Answers bounded (512 bytes buffered, one line per answer, printable values
  of 64 characters at most) and matched against the expected header; only
  MAC addresses are keys in `/data`, and its tables have no prototype.

[Unreleased]: https://github.com/LM1LC3N7/gladys-jvc-projector/commits/main
