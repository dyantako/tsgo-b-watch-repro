# `tsc -b --watch` does not arm for a long time on a large project-references solution (native compiler)

On a large `tsc -b --watch` solution (native compiler / `tsgo`), `Found 0 errors. Watching
for file changes.` prints within a couple of seconds, but no filesystem watch is actually
registered until `computeDesiredWatches` returns — which on a large solution takes tens of
seconds. Any edit made during that window is silently lost (fsevents does not replay
pre-arm events).

Plain `tsc --watch` (single project, no `-b`) is not affected.

## Environment

- `typescript@7.0.2` (also reproduces on the `7.1.0-dev` nightly)
- macOS (arm64), Node 24. `tsc` execs the platform `tsgo` binary, so `tsc -b --watch`
  and `tsgo -b --watch` are the same native code.

## Reproduce

```sh
npm install
npm run setup      # generates 15 projects x 1500 shared node_modules packages
npm run watch      # tsc -b --watch --preserveWatchOutput
```

`Watching for file changes.` prints within ~2s, then the process pegs a CPU core before
any watch exists. On this solution that is **~85s**. Confirm nothing is watched yet: edit
a file within the first minute → nothing happens; edit again after the CPU drops to idle →
picked up in ~1s.

A single small project returns from `computeDesiredWatches` in milliseconds and works
fine, so this only appears at solution scale. Larger solutions take proportionally longer.

## Cause

`computeDesiredWatches` (`internal/execute/build/orchestrator.go`) is O(total input +
buildinfo files × number of desired watch dirs). It calls `watchmanager.IsDirCoveredByWatch`
for every input file, every buildinfo file, and every `package.json` ancestor across all
projects, and that helper linearly scans the entire desired-dirs map:

```go
// watchmanager.go
func IsDirCoveredByWatch(dirs map[string]bool, dir string, opts) bool {
    for wdir, recursive := range dirs { /* ContainsPath / ComparePaths */ }  // scans ALL
}
```

On the generated solution: 23,745 buildinfo files × ~1,534 desired dirs. `Realpath` is only
~130ms of the total, so the cost is the coverage scan, not I/O.

## Measuring

Timing `computeDesiredWatches` (start/return) shows the full duration; the watch is
registered (`ReconcileWatches`) only after it returns, which is why the process is idle to
the user yet the watch is dead until then.
