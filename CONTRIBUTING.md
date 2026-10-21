# Contributing

Thanks for helping. AWL has two parts, and they change in different ways:

- **The spec** ([SPEC.md](SPEC.md), [schemas/](schemas/)): the format other people build on. Changes go through a proposal first.
- **The SDK**: the TypeScript reference implementation, in two packages. Normal pull requests.
  - `agent-work-layer` (`packages/core`): types, validator, desk and the `awl` CLI. Depends only on ajv.
  - `agent-work-layer-mcp` (`packages/mcp`): the MCP server and the `awl-desk` command. Uses the core package.

## Ways to help

- Try it with your agents and open an issue about what didn't fit.
- Pick up an issue labeled [`good first issue`](../../labels/good%20first%20issue) or [`help wanted`](../../labels/help%20wanted).
- Build something on top: an implementation in another language, a database store, an A2A binding. See [ROADMAP.md](ROADMAP.md).
- Improve the docs and examples.

## Changing the spec

1. Open an issue with the **Spec proposal** template. Describe the problem before the solution.
2. Discuss it there. Small clarifications can go straight to a PR.
3. A spec PR must update, in the same PR: `SPEC.md`, the JSON Schemas (then run `npm run generate`), the validator, tests for each new rule, the [conformance vectors](conformance/) (a new rule gets its own file), and `CHANGELOG.md`.

Compatibility rules (SPEC.md §11):

- Within 0.x, new fields must be optional. Existing documents must stay valid.
- Never change what an existing field or rule id means. Add a new one instead.
- Rule ids (`R7`, `C2`, ...) are permanent. Retired ids are not reused.

## Working on the SDK

Requires Node 22.18 or later (tests run TypeScript directly).

```sh
npm install            # links the two packages together
npm test               # all tests, core and MCP
npm run typecheck
npm run check          # typecheck, tests, and the package install test
npm run generate       # after editing schemas/*.json; a test fails if you forget
```

The MCP package imports the core by its package name, the way users do, so its tests run against the built core. `npm test` and `npm run typecheck` build the core first.

The Python package lives in `python/`. It needs Python 3.9 or later:

```sh
cd python
python -m venv .venv && .venv/bin/pip install -e ".[test]"
.venv/bin/pytest
```

A rule change goes into both implementations, with the same rule ids, kinds and paths; both run the vectors in [`conformance/`](conformance/), so a mismatch fails a test. After editing `schemas/*.json`, copy them into `python/src/agent_work_layer/schemas/`; a test fails if you forget.

Guidelines:

- Every behavior change comes with a test. Validation rules get a passing case and a failing case.
- Errors thrown on purpose are `AwlError` with a fitting `code`.
- Keep runtime dependencies to a minimum. Discuss before adding one. The core must not depend on the MCP SDK, and `packages/core/src/validator.ts` must not import Node built-ins; tests enforce both.
- Public API changes need a README update and a CHANGELOG entry.

## Pull requests

- One topic per PR. Explain the reason as well as the change.
- `npm run check` must pass. CI runs it on Node 22 and 24.
- By contributing you agree that your work is licensed under the project's [Apache-2.0 license](LICENSE).

## Releases

Minor and major releases bump both packages to the same version; a patch may cover only the package it fixes. Maintainers bump the version in `packages/core/package.json` and `packages/mcp/package.json` (including the MCP package's dependency on the core), run `npm run generate`, and move the CHANGELOG entries under the new version. Then run `npm run check`, merge, and publish a GitHub release tagged `vX.Y.Z`. The publish workflow runs the checks and publishes the core before the MCP package through npm trusted publishing, skipping a package whose version is already on npm. Each package's trusted publisher on npmjs.com must name repository `probita-ai/agent-work-layer` and workflow `publish.yml`.

The Python package has its own version and its own releases. Bump `version` in `python/pyproject.toml` and `__version__` in `python/src/agent_work_layer/__init__.py`, update the CHANGELOG, and publish a GitHub release tagged `python-vX.Y.Z`. The publish workflow checks that the tag and both versions agree, runs the tests and uploads to PyPI through trusted publishing (environment `pypi`). A `python-v` release never publishes to npm, and a `v` release never publishes to PyPI.
