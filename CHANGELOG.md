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

### Security

- Answers bounded (512 bytes buffered, one line per answer, printable values
  of 64 characters at most) and matched against the expected header; only
  MAC addresses are keys in `/data`, and its tables have no prototype.

[Unreleased]: https://github.com/LM1LC3N7/gladys-jvc-projector/commits/main
