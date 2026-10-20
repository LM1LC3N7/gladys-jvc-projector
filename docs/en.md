# JVC Projector for Gladys

Control your **JVC D-ILA** projectors (DLA-NZ, NX, N, X, RS and Z series,
2012 models on) from Gladys, on your local network, without any cloud: power
on, standby, input, picture mode, remote keys, signal and lamp / laser hours.

> **Important.** This integration has never been tested with a real
> projector: it was written from the `pyjvcprojector` library (the one of
> Home Assistant) and tested against a fake projector only. Your feedback is
> welcome. Unofficial integration, not affiliated with JVCKENWOOD.

## Installation

1. Connect the projector to your network (LAN port) and give it a **fixed IP
   address** in your router (reserved DHCP lease), or set one in its Network
   menu.
2. To control it **in standby**, keep its network on in standby: set **ECO
   mode** to Off (otherwise it leaves the network in standby, and only the
   remote can turn it on).
3. Recent models (2024 on, and some after a firmware update) require a
   **network password** set in the projector's Network menu: type it in the
   configuration. Older models have none: leave the field empty.
4. In Gladys, install the **JVC Projector** integration, open its
   configuration and type the IP addresses, separated by commas (for example
   `192.168.1.50`; port 20554 by default, another one as
   `192.168.1.50:20555`).
5. The projectors appear in the **Discovery** tab: create them.

The projector must be on, or in standby with its network kept on, the first
time: the integration reads its model and its MAC address, which identifies
it from then on (its address may change: type the new one).

## What you get

| Feature           | Gladys type              | Note                                                                |
| ----------------- | ------------------------ | ------------------------------------------------------------------- |
| Power             | binary state (read only) | 1 on or warming up, 0 standby, cooling down, error or not reachable |
| Power status      | text (read only)         | On, Warming up, Cooling down, Standby, Error, Not reachable         |
| Power on          | button                   | sent from standby only                                              |
| Standby           | button                   | sent when on; while warming up, sent as soon as the projector is on |
| Input             | list                     | HDMI 1, HDMI 2                                                      |
| Picture mode      | list                     | the modes of your model (Film, Cinema, Natural, HDR10, User 1…)     |
| Remote key        | list                     | Menu, arrows, OK, Back, Info, Lens control, Mode 1 to 10…           |
| Signal            | binary state (read only) | 1 when the input has a signal                                       |
| Lamp / laser time | duration in hours        | read while the projector is on                                      |

On purpose, no **switch**: an "everything off" or "everything on" from a
voice assistant or a scene never turns your projector on or off. Use the
two buttons in your scenes.

Input, picture mode and signal are read while the projector is on (the
picture mode with a signal only, as Home Assistant does). The picture mode
list follows the model the projector reports; a model the integration does
not know offers no picture mode.

## Commands

The MAC address and the power state are read from the projector just before
each command (another projector at the address: nothing is sent, and the
address is forgotten):

- **Power on** is only sent in standby. Already on or warming up: nothing
  to do. While **cooling down**, the projector refuses it: the command is
  refused, nothing sent; try again once it is in standby.
- **Standby** is only sent when on. Already in standby or cooling down:
  nothing to do. While **warming up**, the projector ignores it: Gladys gets
  the answer "warming up: standby will be sent once it is on, nothing sent
  yet", and the integration sends it as soon as the projector is on (checked
  every 5 seconds, within 3 minutes, a failed read included); pressing
  Power on meanwhile cancels it. Standby is never refused because the state
  could not be read: it is then sent anyway. It goes before the other
  commands waiting, and never waits behind a background read or the slow
  confirmation of an input or picture mode change (that connection is
  closed; the change stays "sent, without confirmation").
- **Input**, **picture mode** and **remote key** are only sent when the
  projector is on.

Every command is answered within 4 seconds (Gladys waits 5 seconds). A
command that left without the projector confirming it in time is reported
"sent, without confirmation" (an input change can take up to 10 seconds on
the projector); one that could not leave is reported "nothing sent". The
state is read again 3 seconds after each command.

## Network password

The password is kept by Gladys in its database, never shown again, and sent
only to the projectors, at the start of each connection (padded as the
older models expect it, then in the SHA-256 form of the recent models when
the first one is refused, as `pyjvcprojector` does). The integration never
writes it to its data folder, nor to its logs, statuses or error messages.

A **refused password** stops the tries to that projector: the integration
status says so, and the password is tried again only when you save the
configuration, or 30 minutes later (never in a loop). A projector that
closes the connection or stops answering after refusing a password counts
as a refusal too. Fix it in the
projector's Network menu or in the configuration, then save.

## Configuration button

- **Check the projectors**: reads each projector now (power, lamp hours) and
  shows the refresh interval.

## Refresh, status and limits

- The state of each projector is read every 15 seconds by default (10 to
  300), in one short connection (the projector takes one client at a time:
  close the JVC app or another controller if it says "busy").
- A projector that does not answer shows power 0 and "Not reachable", and is
  named in the integration status; it is asked again at every refresh, never
  faster.
- If another projector answers at the address of a created one (address
  changed), its address is forgotten and it is never commanded there: type
  its new address.

## Data and privacy

The integration keeps in `/data/jvc-projector.json` the known projectors
(MAC address, address, port, model, picture modes) and the addresses whose
password was refused, with the time of the next try. Nothing leaves your
local network.

## Known limits

- HDMI 1 and HDMI 2 only (the inputs `pyjvcprojector` maps).
- No lens memory, laser power, installation mode, anamorphic or HDR settings
  yet.
- One password for all the projectors.
- Never tested with a real projector: real answers may differ.
