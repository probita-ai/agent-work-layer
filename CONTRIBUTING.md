# Contributing

Thanks for helping. AWL has two parts, and they change in different ways:

- **The spec** ([SPEC.md](SPEC.md), [schemas/](schemas/)): the format other people build on. Changes go through a proposal first.
- **The SDK**: the TypeScript reference implementation, in two packages. Normal pull requests.
  - `agent-work-layer` (`src/`): types, validator, desk and the `awl` CLI. Depends only on ajv.
  - `agent-work-layer-mcp` (`mcp/`): the MCP server and the `awl-desk` command. Uses the core package.

## Ways to help

- Try it with your agents and open an issue about what didn't fit.
- Pick up an issue labeled [`good first issue`](../../labels/good%20first%20issue) or [`help wanted`](../../labels/help%20wanted).
- Build something on top: an implementation in another language, a database store, an A2A binding. See [ROADMAP.md](ROADMAP.md).
- Improve the docs and examples.

## Changing the spec

1. Open an issue with the **Spec proposal** template. Describe the problem before the solution.
2. Discuss it there. Small clarifications can go straight to a PR.
3. A spec PR must update, in the same PR: `SPEC.md`, the JSON Schemas (then run `npm run generate`), the validator, tests for each new rule, and `CHANGELOG.md`.

Compatibility rules (SPEC.md §11):

- Within 0.x, new fields must be optional. Existing documents must stay valid.
- Never change what an existing field or rule id means. Add a new one instead.
- Rule ids (`R7`, `C2`, ...) are permanent. Retired ids are not reused.

## Working on the SDK

Requires Node 22.18 or later (tests run TypeScript directly).

```sh
npm install            # also links mcp/ to the local core package
npm test               # all tests, core and MCP
npm run typecheck
npm run check          # typecheck, tests, and the package install test
npm run generate       # after editing schemas/*.json; a test fails if you forget
```

The MCP package imports the core by its package name, the way users do, so its tests run against the built core. `npm test` and `npm run typecheck` build the core first.

Guidelines:

- Every behavior change comes with a test. Validation rules get a passing case and a failing case.
- Errors thrown on purpose are `AwlError` with a fitting `code`.
- Keep runtime dependencies to a minimum. Discuss before adding one. The core must not depend on the MCP SDK, and `src/validator.ts` must not import Node built-ins; tests enforce both.
- Public API changes need a README update and a CHANGELOG entry.

## Pull requests

- One topic per PR. Explain the reason as well as the change.
- `npm run check` must pass. CI runs it on Node 22 and 24.
- By contributing you agree that your work is licensed under the project's [Apache-2.0 license](LICENSE).

## Releases

Both packages share a version. Maintainers bump it in `package.json` and `mcp/package.json` (including the MCP package's dependency on the core), run `npm run generate`, move the CHANGELOG entries under the new version, and publish a GitHub release. The publish workflow pushes the core, then the MCP package, to npm with provenance.
