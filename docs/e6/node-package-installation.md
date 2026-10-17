# E6-D2: installing declarative node packs

This contract implements the safe file-install subset of A3 §24.2–24.3 and acceptance criteria A3-041/A3-042. It installs data-only JSON node definitions; it does not install executable extensions.

## Artifact and project lock

Validated package files use a fixed path derived from the namespaced package ID and exact SemVer:

```text
.a3/node-packages/<package-id>--<version>.json
```

The path is never read from imported JSON. The project lock is `.a3/node-packages.lock.json`, validated against [`node-package-install-lock.schema.json`](../../schemas/e1/node-package-install-lock.schema.json). Each record pins `(packageId, version)`, SHA-256 of the exact stored artifact bytes, import origin (`builder` or `file-import`), declared license and API version, and state (`installed` or `removed`). Duplicate package/version records, unsupported lock versions, invalid paths, artifact hash mismatch, or mismatched license/API metadata fail closed. Unknown packages in the catalog without a verified installed record remain available for a person to preview; they are not registered as node types.

## Review and apply

The renderer submits bytes from one selected JSON file. The trusted host rejects invalid UTF-8/JSON, artifacts over 4 MiB, invalid package schemas, non-empty requested permissions, executable-looking properties, unsupported `a3ApiVersion`, invalid declaration metadata, duplicate type/collection IDs, and conflicts with installed IDs. It validates a safe license declaration shape but cannot verify the license grant or artifact author. The package manager displays source category, exact digest, IDs, declared license/API version, and the derived project destination. It neither extracts archives nor opens paths inside a package.

Installation requires an explicit confirmation after that review. The host checks the same input digest again, rereads the project lock and artifact, repeats schema and collision checks, and writes the artifact plus lock through the E1 journaled writer with `document.edit`. The operation has recoverable journal semantics but is a multi-file logical transaction (`atomic: false`). No `package.install` grant is claimed because the present package contains no executable code and E0 did not establish that capability.

## Updates, removal, and fallback

Package versions are immutable. An existing `(packageId, version)` with different content is a conflict and keeps its original bytes. A distinct version can be installed side-by-side; this does not rewrite existing entities, and no schema migration is offered. A migration-dependent change remains unavailable until a reviewed migration is implemented.

Removal marks the lock entry `removed` but keeps the JSON artifact. Types leave the active registry on the next store state; entities and relation documents are not modified. Their stored properties, content references, ports, and endpoints remain available to the generic fallback. Reinstall previews and rechecks the retained artifact digest before marking it installed again. A missing artifact or corrupted lock leaves affected entities in fallback and reports diagnostics.

## Evidence and limits

The focused store tests cover malformed UTF-8/JSON, unsupported API versions, path-shaped license values, duplicate package/version content, no write during preview, confirmation/digest checks, journal rollback after the first installed file, and remove/reinstall while asserting the entity bytes do not change. No remote catalog, archive format, signature/authenticity check, legal license audit, code execution, custom renderer, migration, or power-loss durability claim is included.
