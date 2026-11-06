# Security policy

RSilo holds the only copy of what your apps store, so security reports are welcome and taken seriously.

## Reporting a vulnerability

Please report privately through GitHub: **[Report a vulnerability](https://github.com/jonocodes/RSilo/security/advisories/new)** (the *Security* tab → *Report a vulnerability*). Do not open a public issue for anything that could put someone's data or account at risk.

Include what you can of: the affected endpoint or file, how to reproduce it, and what an attacker gains. Expect an acknowledgement within a week. Once a fix ships, the advisory is published with credit unless you would rather stay anonymous.

## Supported versions

Only the latest [release](https://github.com/jonocodes/RSilo/releases) and `main` get fixes. A Deploy-button Instance does not update itself; see [Updating a Deploy-button Instance](docs/self-hosting.md#updating-a-deploy-button-instance).

## Scope

In scope: the Worker (storage, OAuth, WebFinger, `/account`, consent) and the deploy and setup scripts. The offline server and its Docker image are for local use and test suites, not production; reports against them are still welcome, but they are not hardened for exposure to the internet.

The design choices behind the security model are recorded in the [ADRs](docs/adr/), and known trade-offs are listed under [Known limitations](README.md#known-limitations).
