# Local repository cache

The `extensions/repo-cache.ts` extension keeps a reconstructible, local SHA-256 index. It does not intercept ordinary reads, shell commands, or native search. It makes no model calls and uses no external service.

## Activation

The package manifest includes the extension. Update/reload the package, or preview it alone:

```sh
pi -e ./extensions/repo-cache.ts
```

Use `/repo-cache-status` for indexed/changed/pending file counts, file/chunk cache hits, chunk processing misses, file hash counts, last successful update duration, and cache size in bytes. Counters are per extension process; the index survives restarts. Status does not trigger another scan.

Optional additional exclusions are repository-relative path prefixes, not globs:

```sh
pi -e ./extensions/repo-cache.ts --repo-cache-exclude=fixtures,third-party/generated
```

The tools are:

- `get_changed_files`: reports changes accumulated since the previous call (all new entries on an empty cache), the current HEAD, and Git's two-column staged/unstaged/untracked status. Background updates do not consume these changes. Results are capped at 200 entries per list and explicitly marked when truncated. Native `find`/`grep` can inspect larger results.
- `get_file_summary`: returns a current working-tree hash, last successfully indexed version/time, byte count, and a deterministic declaration/heading outline. This is a sampled outline, not a semantic summary or complete symbol table: at most 32 declarations per 64-line chunk and 100 overall.
- Use Pi's existing `grep`, `find`, and `read` for search and full contents. There is deliberately no duplicate `search_code` implementation or cached search result that could hide a new match.

When the cache tools are active, Pi adds short cache-first guidelines to its system prompt: check `get_changed_files` before broad exploration, and check `get_file_summary` before rereading a previously explored file. An unchanged hash allows reuse of previously read content still available in context. Exact-code needs, missing prior context, excluded files, and unavailable or truncated cache results still permit direct reads and native discovery. These are agent instructions, not tool restrictions.

No file lists or cache metadata are automatically added to the model context.

## Detection and freshness

Git discovers the repository root, enumerates tracked and non-ignored untracked files, supplies staged/unstaged status, and compares HEAD versions after commits or branch switches. File hashes always describe the working tree, never staged or committed blobs. Unborn repositories work too. Without Git, a bounded filesystem walker supplies the inventory and the existing access-policy ignore handling applies.

Session startup processes at most 100 entries. A recursive filesystem watcher records dirty paths; an unreferenced two-second timer processes up to 100 pending entries per batch. Each agent run reconciles Git and dirty paths with the same budget, without auditing all existing metadata. A 30-second metadata audit catches missed events. Without Git, the inventory is reused until a notification or audit requests rediscovery. Unsupported/failed watchers degrade to reconciliation and audits.

Before returning changed files, the tool awaits a full metadata audit. Before returning an outline, the tool reconciles pending work and validates the requested file even if its notification was lost. Metadata includes size, inode, mode, mtime, and ctime, so restoring an mtime alone does not hide an edit. Only metadata-changing files are read and SHA-256 hashed. Unchanged 64-line chunks reuse persisted outline results, including after restart. Stable descriptor/path metadata is checked around reads; repeatedly changing or unreadable files fail the request rather than returning an old outline. Operations are serialized within an extension instance.

These are point-in-time working-tree results, not an atomic snapshot of a repository being concurrently edited. Freshness relies on normal filesystem metadata semantics; native search/read remains available on unusual filesystems. Metadata audits are O(number of eligible files), but do not rehash or reprocess unchanged content. Git inventory/status commands also do O(repository size) metadata work internally. This is not a claim of constant-time repository discovery.

## Storage, limits, and exclusions

Indexes live under `getAgentDir()/cache/repo-index/<sha256(canonical-repository-root)>.json`, outside the repository and session context. Each file entry stores its relative path, SHA-256, metadata, last successfully indexed content version/time, and chunk hashes/results. Atomic replacement and restrictive creation modes protect against torn writes; incompatible or malformed indexes rebuild. Multiple Pi processes may replace the same cache file, but each instance validates its own working-tree metadata and never reloads another process's entries during a session.

Defaults exclude `.git`, `node_modules`, `dist`, `build`, `coverage`, `.next`, `.nuxt`, `.cache`, `.pi`, `target`, and `vendor`; environment files and common credential/media/archive/binary extensions; symlinks; NUL-containing or invalid UTF-8 content; and files larger than 1 MiB. Git ignore rules and `.claudeignore` are respected, including newly applied rules. Binary detection results are cached so unchanged binary files are not repeatedly read. Indexes contain declaration snippets: treat them as private source-derived data, not anonymized metadata.

Inventories are limited to 20,000 eligible paths, non-Git walks to 80,000 visited entries, and persisted indexes to 64 MiB. Git subprocess output is limited to 16 MiB with a ten-second timeout. Exceeding a limit or failing an update produces an explicit error; cache tools do not silently fall back to stale results. Startup is bounded in processed entries and inventory size, not a hard wall-clock deadline. The non-Git walker can still visit many directories during an audit. Use native tools or narrower exclusions for oversized repositories.

To reclaim disk space, stop Pi and remove only the desired repository's index JSON file. No session data or user settings need removal.

## Proof and benchmark

```sh
npm run check
node --test tests/repo-cache.test.mjs tests/resources.test.mjs
node scripts/benchmark-repo-cache.mjs
node scripts/benchmark-repo-cache.mjs /path/to/repository
```

The benchmark uses a disposable cache. Without a path, it builds a temporary committed Git fixture of 500 files with 128 declarations each. With a path, it reads that working tree without modifying it. It reports complete cold indexing, an unchanged warm restart, and five unchanged metadata audits, including hash and processing counts. Timings depend on filesystem and repository size; the important invariant is zero hashes and zero processing misses on an unchanged warm run.

Measured locally on Node.js 24.21.0 / Git 2.47.3 (single runs, not statistical performance claims):

| Working tree | Complete cold start | Unchanged warm restart | Files hashed, cold / warm |
| --- | ---: | ---: | ---: |
| Synthetic 500-file fixture | 242.87 ms | 158.58 ms | 500 / 0 |
| Piexis working tree, 395 indexed files | 439.76 ms | 292.15 ms | 395 / 0 |

Five unchanged agent reconciliations took 56.70 ms total on the committed fixture, with zero file metadata checks, hashes, or chunk misses. Five full discovery audits took 458.47 ms total, with zero hashes or chunk misses. A one-line edit took 22.74 ms, hashed one file, reused one chunk, and processed one changed chunk. The dirty Piexis working tree took 114.16 ms for five reconciliations, checking metadata for Git's dirty paths but still hashing and processing no unchanged content.
