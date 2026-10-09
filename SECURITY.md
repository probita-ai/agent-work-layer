# Security policy

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting instead: go to the **Security** tab of this repository and choose **Report a vulnerability**.

Include what you found, how to reproduce it, and the impact you expect. You will get an acknowledgement within 7 days.

## Scope

In scope: the SDK, the CLI, the MCP server, and the spec's security rules (SPEC.md §10).

Known limitation, not a vulnerability: the reference desk trusts the `actor` it is given and is meant for development. Production deployments must bind the actor to an authenticated identity.
