/** Host-generated CSP nonce for bundled editor styles; never persisted in project/view state. */
export function editorStyleNonce(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="a3-editor-style-nonce"]')?.content ?? '';
}
