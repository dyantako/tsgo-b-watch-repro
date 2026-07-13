# `tsc -b --watch` is unusable on a large project-references / pnpm monorepo (native compiler)

On a large `tsc -b --watch` (native compiler / `tsgo`) solution there are two separate
problems. The first is reproduced deterministically by the setup in this repo; the second
was observed on a real ~36-project pnpm monorepo and is described with its debug-log
signature (the minimal setup here does not reproduce it).

Plain `tsc --watch` (single project, no `-b`) is not affected by either.

## Environment

- `typescript@7.0.2` (also reproduces on the `7.1.0-dev` nightly)
- macOS (arm64), Node 24. `tsc` execs the platform `tsgo` binary, so `tsc -b --watch`
  and `tsgo -b --watch` are the same native code.

---

## Problem 1: `computeDesiredWatches` is O(files × dirs) — the watch takes tens of seconds to a couple of minutes to arm

`Found 0 errors. Watching for file changes.` prints within a couple of seconds, but no
filesystem watch is actually registered until `computeDesiredWatches`
(`internal/execute/build/orchestrator.go`) returns, which is O(total input + buildinfo
files × number of desired watch dirs). Any edit made during that window is silently lost
(fsevents does not replay pre-arm events).

`computeDesiredWatches` calls `watchmanager.IsDirCoveredByWatch` for every input file,
every buildinfo file, and every `package.json` ancestor across all projects, and that
helper linearly scans the entire desired-dirs map:

```go
// watchmanager.go
func IsDirCoveredByWatch(dirs map[string]bool, dir string, opts) bool {
    for wdir, recursive := range dirs { /* ContainsPath / ComparePaths */ }  // scans ALL
}
```

### Reproduce

```sh
npm install
npm run setup      # 15 projects x 1500 shared node_modules packages
npm run watch      # tsc -b --watch --preserveWatchOutput
```

`Watching for file changes.` prints within ~2s, then the process pegs a CPU core inside
`computeDesiredWatches` before any watch exists. On this solution that is **~85s**
(23,745 buildinfo files × ~1,534 desired dirs; `Realpath` is only ~130ms of it, so the
cost is the coverage scan, not I/O). On the real monorepo it was ~74s for a 30-project
subgraph and longer for the full 36-project graph.

You can confirm nothing is watched yet: after `Watching for file changes.` prints, edit a
file within the first minute and nothing happens; edit again after the CPU drops to idle
and it is picked up in ~1s.

A single small project returns from `computeDesiredWatches` in milliseconds and works
fine, which is why this only appears at solution scale.

---

## Problem 2 (observed on the real monorepo): once the watch arms, an fsevents overflow forces a continuous full-rebuild loop

On the real monorepo, once the watch is actually live, a single save triggers one
legitimate rebuild followed by an endless series of full rebuilds a few seconds apart,
each driven by a filesystem-watch overflow rather than any file event.

With `TS_WATCH_DEBUG=1` the loop is a flood of:

```
[watch] resolved …/node_modules/~/areas/infrastructure/components/…/Server-Healthy-Ssh.svg to ancestor …/node_modules
[watch] resolved …/apps/portal/node_modules/@types/…/AuditStream to ancestor …/apps/portal/node_modules/@types
…
[watch] event overflow, triggering rebuild
[watch] event overflow, triggering rebuild
[watch] event overflow, triggering rebuild
```

Failed module-resolution lookups — the portal's `~/*` path alias and asset imports
(`.svg` / `.less` / `.png`) treated as package specifiers — resolve to their nearest
existing ancestor, which is the `node_modules` / `.pnpm` tree, and that tree is watched.
A tree that large makes macOS drop fsevents events (`ErrOverflow`), which `tsgo` turns
into a forced full rebuild; the rebuild re-runs resolution and re-registers the same
watches, producing another overflow, and so on.

This is masked on stock `typescript@7.0.2` by Problem 1: the ~74–94s `computeDesiredWatches`
stall means the watch is barely usable, so in normal use the loop is rarely reached (and
when it is, each iteration is separated by another full `computeDesiredWatches` pass). It
becomes obvious once the watch arms quickly.

The minimal setup in this repo does **not** reproduce Problem 2: it needs failed-lookup
imports (a path alias, asset imports) plus a `node_modules` tree large enough to overflow
fsevents. It is included here only as an observation with its log signature.

---

## Net effect

`tsc -b --watch` over the whole solution does not provide a working edit/rebuild loop on
this monorepo: either it never arms in time (Problem 1) or, once it does, it rebuilds
continuously (Problem 2). Plain `tsc --watch --noEmit` per project works.
