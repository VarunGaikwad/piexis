# Agents Guide

## Project

Piexis is a TypeScript Pi package providing permission-mode extensions, skills, prompts, and themes. It requires Node.js 24+.

## Development

Install dependencies and run checks with:

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Run the sandbox-specific tests when the required host sandbox dependencies are available:

```sh
npm run test:sandbox
```

## Conventions

- Use ESM and TypeScript conventions already present in the repository.
- Keep changes focused and preserve the existing permission and security boundaries.
- Add or update tests for behavior changes.
- Do not commit generated output, local configuration, secrets, or dependency directories.

## Validation

Before submitting changes, run `npm run check` and `npm test`. Review the diff and confirm that no credentials or unrelated files are included.
