# Security Policy

## Supported versions

Security fixes are applied to the latest code on the `main` branch. Older commits and local
builds are not maintained as separate supported releases.

## Network trust boundary

CKast is designed for a trusted local network. Its HTTP and WebSocket traffic is unencrypted,
and the broadcaster accepts connections from devices on that network. Do not expose port 8080
to the public internet or run CKast on public or untrusted Wi-Fi.

## Reporting a vulnerability

Please report suspected vulnerabilities privately. If GitHub private vulnerability reporting
is enabled for this repository, use **Security → Report a vulnerability**. Otherwise, contact
the repository owner privately through the contact method listed on their GitHub profile.

Include the affected component, reproduction steps, expected impact, and any suggested
mitigation. Do not open a public issue or publish exploit details before the maintainer has had
a reasonable opportunity to investigate and respond.
