# `tsc -b --watch` stops detecting file changes past ~500 watched modules (native compiler)

The native compiler's **build/solution watch mode** (`tsc -b --watch`, i.e. `tsgo -b --watch`)
silently stops delivering file-change events once the program watches more than roughly
**500 resolved `node_modules` modules**. The initial build completes, prints
`Watching for file changes.`, and then never reacts to any edit. No error, no rebuild.

Plain `tsc --watch` (non-build mode) on the same project is unaffected.

## Environment

- `typescript@7.0.2` (also reproduces on `typescript@next`, `7.1.0-dev.20260712.1`)
- macOS 26.5 (arm64), Node v24
- `tsc` here is the native compiler: the `tsc` bin in `typescript@7` execs the platform
  `tsgo` binary, so `tsc -b --watch` and `tsgo -b --watch` run identical code.

## Reproduce

```sh
npm install
npm run setup        # generates src/index.ts importing 600 node_modules packages
npm run watch        # tsc -b --watch --preserveWatchOutput
```

Wait for `Watching for file changes.`, then in another terminal introduce a type error:

```sh
printf 'export const marker: number = "boom";\n' >> src/index.ts
```

**Expected:** watch reports `File change detected` and a `TS2322` error.
**Actual:** nothing. The watcher never fires again for any change.

## It's a threshold, and it's `-b`-specific

`setup.mjs` takes the module count as an argument. Editing `src/index.ts` after the
watcher is armed:

| Command | Modules imported | File change detected? |
| --- | --- | --- |
| `tsc -b --watch` | 400 | yes |
| `tsc -b --watch` | 500 | yes |
| `tsc -b --watch` | 600 | **no** |
| `tsc -b --watch` | 1000 | **no** |
| `tsc --watch` (no `-b`) | 1000 | yes |
| `tsc --watch` (no `-b`) | 3000 | yes |

So:

- The cliff sits between 500 and 600 watched modules (≈512).
- It is specific to build/solution mode (`-b`). Plain `--watch` watches 3000+ modules fine.
- It is driven by module-resolution watches, not raw file count: a single-project
  `--watch` over 3000 local files/directories works; ~600 `node_modules` imports does not.

## Why it matters

In a real pnpm monorepo (~two dozen project references, thousands of resolved modules)
`tsc -b --watch` never picks up any edit, which makes the standard "watch the whole
solution" type-check loop unusable on the native compiler. Plain `tsc --watch` per
project, or the previous JS-based `tsc` (`typescript@6.x`) `-b --watch`, both work.
