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

## Root cause

`internal/fswatch/fsevents_darwin.go` (macOS only, which is why this is Darwin-specific).

`startFSEventsStreams` tries to watch every directory in a single FSEvents stream and
only falls back to 512-path chunks *if that first call returns an error*:

```go
// fsevents_darwin.go
const fseventsPathsPerStream = 512   // line 225

func startFSEventsStreams(...) (...) {
    ...
    stream, err := startStream(paths, watches)   // ALL paths, unbounded (line 263)
    if err == nil {
        return []*fseventsStream{stream}, nil     // taken in production
    }
    // chunk into fseventsPathsPerStream streams -- only reached on error
    ...
}
```

512 matches the 500-works / 600-fails cliff exactly. The code knows a stream can't hold
more than 512 paths, but gates the chunking behind an error the real macOS API never
returns: `fsEventStreamCreate` + `fsEventStreamStart` with >512 paths succeed and return
a non-nil stream, so `err == nil`, the early return fires, and directories past the limit
are silently never watched. No error, no rebuild.

The chunking fallback is only covered by `TestFSEventsSharedStreamFallsBackToChunks`,
which *mocks* `startStream` to fail on the first call -- so the fallback is green in CI
but dead code against the real FSEvents API.

**Why `-b` only:** both watch modes use this fsevents backend, but plain `tsc --watch`
coalesces `node_modules` into a few recursive ancestor watches and stays well under 512
(handles 3000+ modules here). Build/solution mode registers one directory watch per
resolved module location, so resolving more than ~512 `node_modules` packages exceeds
the single-stream limit.

**Suggested fix:** chunk on count up front rather than waiting for an error that never
comes -- if `len(paths) > fseventsPathsPerStream`, split into chunks immediately.
