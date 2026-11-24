# Working on SolML

| Change | Also update |
| --- | --- |
| `EscrowTerms` layout (Rust `state.rs`) | `packages/compiler/src/terms.ts`, `spec/IR.md`, then `npm run fixtures` |
| A program hard bound | `HARD` in `packages/compiler/src/compile.ts`, `spec/SSS.md` |
| Account order of an instruction | The matching builder in `packages/sdk/src/program.ts` |
| A SolML element or SSS property | `spec/SOLML.md` or `spec/SSS.md`, and a compiler test |

CI fails when committed fixtures differ from what the compiler produces, so the Rust conformance tests always run against current compiler output.

Run everything before a push:

```bash
npm run build && npm run build:program && npm test && cargo test
```
