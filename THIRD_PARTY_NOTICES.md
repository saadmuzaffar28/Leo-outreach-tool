# Third-party notices

Leo Outreach incorporates the following third-party project. Its license is
reproduced in full below and in `services/email-verifier/LICENSE-AFTERSHIP.txt`.

## AfterShip/email-verifier

- Project: https://github.com/AfterShip/email-verifier
- License: MIT (see below)
- Consumption method: **Go module dependency** of the local verification
  service in `services/email-verifier/` (declared in
  `services/email-verifier/go.mod`). No library source code was copied into
  this repository; the service links against the module at build time
  (`npm run verifier:build`).
- Role: the core email verification engine (syntax, DNS/MX, SMTP mailbox and
  catch-all checks, disposable/role/free-provider detection, domain typo
  suggestions) behind Leo Outreach's own adapter
  (`src/lib/verification/aftership-adapter.ts`) and normalized result model.
- Attribution: "Email verification engine: AfterShip/email-verifier (MIT)".

```
MIT License

Copyright (c) 2020 AfterShip

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
