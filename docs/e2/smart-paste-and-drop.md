# E2-C2 · Smart paste and external drops

This implementation covers the first Windows desktop workflow for A3-008 and A3-024.

## Clipboard

The host reads the clipboard only after a paste gesture on the canvas background. An active input, textarea, contenteditable element, canvas node, or edge keeps its normal paste behavior. `Ctrl+Shift+V` is not intercepted; the visible **Pegar como texto** action always reads plain text.

Smart paste resolves content in this order:

1. A valid `application/x-a3-clipboard-fragment+json` envelope.
2. An image item from the clipboard, stored as a local binary resource (up to 10 MiB).
3. A recognized HTTP/HTTPS URL: YouTube, image URL, or web-link card.
4. Plain text as a short-text node.

The A3 envelope is UTF-8 JSON with exactly these fields: `{"format":"a3-clipboard-fragment","version":1,"kind":"text"|"url","value":"..."}`. Invalid envelopes fall through to the next clipboard format. URL parsing performs no request. YouTube cards keep the URL and use an ID-based fallback title; image URLs stay remote references and are not downloaded.

## File drop

The sandboxed preload obtains dropped paths with Electron `webUtils`, then sends them to the main process. Raw paths and mount handles stay in the host. The host rejects network paths, symlinks and junctions, limits a loose drop to 20 files, a folder to 128 files, each file to 10 MiB, and the batch to 32 MiB. Folder traversal is preview-only until the user confirms an action and rejects linked directories.

Loose files select **Copiar** by default. A folder requires choosing **Copiar** or **Referenciar**. The preview shows names, sizes, destination paths, and the read-only source permission. Resource IDs make destinations unique; the transactional store checks them again before writing. Copy creates a project resource and canvas node in the same journaled command. Reference creates a mounted-file resource and leaves source bytes intact. Cancelling removes the host-only preview token and creates no project document or copied file.

**Mover** is shown but disabled. The accepted E1 mount service does not have safe external deletion by file handle on Windows (`mount.write` is unavailable), so A3 does not risk deleting a changed source path.

The host approves a local read-only mount and the project broker's `mount.read` grant before reading. Store writes still pass through the project's normal document/diagram edit authorization and transaction writer. Each file in a multi-file drop is a complete node/resource transaction; an interruption can leave already completed nodes while pending files remain in the preview for retry or cancellation.
