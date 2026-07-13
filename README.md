# `tsc -b --watch` misses file changes on large solutions (native compiler)

On a large project-references solution, the native compiler's build/solution watch
(`tsc -b --watch`, i.e. `tsgo -b --watch`) prints `Watching for file changes.` almost
immediately but then does not react to edits for a long time (tens of seconds to
minutes). During that window every change is silently dropped. Plain `tsc --watch`
(single project) is unaffected.

Root cause: `computeDesiredWatches` in `internal/execute/build/orchestrator.go` is
O(files × dirs) and takes ~85s on the solution generated below (and ~74s on a real
30-project monorepo subgraph) before any filesystem watch is registered.

## Environment

- `typescript@7.0.2` (also reproduces on the `7.1.0-dev` nightly)
- macOS (arm64), Node 24. The `tsc` bin execs the platform `tsgo` binary, so
  `tsc -b --watch` and `tsgo -b --watch` are the same native code.

## Reproduce

```sh
npm install
npm run setup      # generates 15 projects x 1500 shared node_modules packages
npm run watch      # tsc -b --watch --preserveWatchOutput
```

You will see `Found 0 errors. Watching for file changes.` within a couple of seconds,
but the process then pegs a CPU core for ~85s inside `computeDesiredWatches` before any
watch exists. An edit made during that window is lost:

```sh
# a few seconds after "Watching for file changes" prints:
printf 'export const marker0: number = "boom";\n' >> projects/p0/src/index.ts
```

Expected: `File change detected` + a `TS2322` error. Actual: nothing, because no watch
is registered yet. (A single small project returns from `computeDesiredWatches` in
milliseconds and works fine, which is why the bug only shows at solution scale.)

## Root cause

`internal/execute/build/orchestrator.go`, `computeDesiredWatches()`.

For every input file, every buildinfo file, and every `package.json` ancestor across
*all* projects, it calls `watchmanager.IsDirCoveredByWatch`, which linearly scans the
entire desired-dirs map:

```go
// watchmanager.go
func IsDirCoveredByWatch(dirs map[string]bool, dir string, opts) bool {
    for wdir, recursive := range dirs { /* ContainsPath / ComparePaths */ }  // scans ALL
}
```

That makes the pass O(files × dirs). On the generated solution: 23,745 buildinfo files
and ~1,534 desired dirs → **`computeDesiredWatches` takes ~85s** (measured; `Realpath`
is only ~130ms of it, so the cost is the coverage scan, not I/O).

Consequences:
1. `Start()` prints `Watching for file changes.` from the initial build report, then
   calls `Watch()`, which sits in `computeDesiredWatches` for ~85s before registering a
   single watch. Edits in that window are dropped (fsevents does not replay pre-arm
   events).
2. `DoCycle()` (the per-change handler) recomputes the whole desired-watch set again on
   every change, so even once armed it is unusable at this scale.

Plain `tsc --watch` is the single-project watcher (`internal/execute/watcher.go`) and
does not do this per-file × per-dir solution reconciliation.

## The check is only O(recursive) work

Only wildcard (recursive) dirs can cover *other* dirs; every other entry is added
non-recursive and only covers itself, which is an O(1) map lookup. Tracking the small
recursive set (15 entries here) separately and using a map lookup for exact match takes
`computeDesiredWatches` from **~85s to ~105ms** on this solution:

```go
recursiveDirs := []string{}            // maintained as recursive dirs are added
covered := func(dir string) bool {
    if _, has := desiredDirs[dir]; has { return true }   // exact match, O(1)
    for _, wdir := range recursiveDirs {                 // only the recursive set
        if tspath.ContainsPath(wdir, dir, opts) { return true }
    }
    return false
}
```

(A production fix should key the coverage set on normalized/`ToPath` paths so the O(1)
exact-match is `ComparePaths`-correct on case-insensitive filesystems; a raw string map
misses case-variant duplicates the current scan folds together.)

## Measure it yourself

Add timing around the function and rebuild `tsgo`:

```go
// top of computeDesiredWatches
start := time.Now()
// before the return
fmt.Fprintf(os.Stderr, "[watch] computeDesiredWatches took %v (%d dirs)\n",
    time.Since(start), len(desiredDirs))
```
