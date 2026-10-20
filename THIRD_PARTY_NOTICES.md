# Third-party notices

This integration ports to JavaScript the logic of the following project: the
JVC D-ILA network protocol (TCP 20554, the `PJ_OK` / `PJREQ` / `PJACK`
handshake, the password in its padded and SHA-256 forms, the reference and
operation frames and their acks), the spacing of the connections and of the
commands, the model specifications and the value maps of the power, input,
signal, lamp time, remote and picture mode commands (`src/jvc/`). Nothing of
it is installed at runtime; its notice is reproduced below.

## pyjvcprojector 2.1.0

<https://github.com/SteveEasley/pyjvcprojector> (the library behind the Home
Assistant JVC Projector integration), tag `v2.1.0` of 2026-10-12

```
MIT License

Copyright (c) 2021 Steve Easley

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Home Assistant, JVC Projector integration

<https://github.com/home-assistant/core/tree/dev/homeassistant/components/jvc_projector>
(Apache License 2.0): only consulted, no code copied. Its use of the MAC
address as the identity of a projector, the reads made only when the
projector is on (input, signal, lamp time; the picture mode with a signal
only) and the list of the remote keys it offers are reused as facts.

## LM1LC3N7/gladys-cambridge-audio and LM1LC3N7/gladys-panasonic-viera

The structure of the app, the `/data` store, the command queue and budget,
and the handler wiring follow integrations of the same author, under the
Apache License 2.0 of this repository.
