# Contributing

Thanks for helping. AWL has two parts, and they change in different ways:

- **The spec** ([SPEC.md](SPEC.md), [schemas/](schemas/)): the format other people build on. Changes go through a proposal first.
- **The SDK** (`src/`): the TypeScript reference implementation. Normal pull requests.

## Ways to help

- Try it with your agents and open an issue about what didn't fit.
- Pick up an issue labeled [`good first issue`](../../labels/good%20first%20issue) or [`help wanted`](../../labels/help%20wanted).
- Build something on top: an implementation in another language, a database store, an A2A binding. See [ROADMAP.md](ROADMAP.md).
- Improve the docs and examples.

## Changing the spec

1. Open an issue with the **Spec proposal** template. Describe the problem before the solution.
2. Discuss it there. Small clarifications can go straight to a PR.
3. A spec PR must update, in the same PR: `SPEC.md`, the JSON Schemas, the validator, tests for each new rule, and `CHANGELOG.md`.

Compatibility rules (SPEC.md §11):

- Within 0.x, new fields must be optional. Existing documents must stay valid.
- Never change what an existing field or rule id means. Add a new one instead.
- Rule ids (`R7`, `C2`, ...) are permanent. Retired ids are not reused.

## Working on the SDK

Requires Node 22.18 or later (tests run TypeScript directly).

```sh
npm install
npm test               # all tests
npm run typecheck
npm run check          # typecheck, tests, and the package install test
```

Guidelines:

- Every behavior change comes with a test. Validation rules get a passing case and a failing case.
- Errors thrown on purpose are `AwlError` with a fitting `code`.
- Keep runtime dependencies to a minimum. Discuss before adding one.
- Public API changes need a README update and a CHANGELOG entry.

## Pull requests

- One topic per PR. Explain the reason as well as the change.
- `npm run check` must pass. CI runs it on Node 22 and 24.
- By contributing you agree that your work is licensed under the project's [Apache-2.0 license](LICENSE).

## Releases

Maintainers bump the version in `package.json`, move the CHANGELOG entries under the new version, and publish a GitHub release. The publish workflow pushes to npm with provenance.
