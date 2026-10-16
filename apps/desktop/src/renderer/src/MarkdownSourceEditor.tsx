import { useEffect, useRef } from 'react';
import { markdown } from '@codemirror/lang-markdown';
import { forceParsing, syntaxTree } from '@codemirror/language';
import { Compartment, EditorState } from '@codemirror/state';
import type { PageViewState } from '../../shared/desktop-api';
import { basicSetup, EditorView } from 'codemirror';
import { inspectMarkdownParse } from '@a3/domain/markdown';
import { editorStyleNonce } from './editor-style';

export interface MarkdownParseDiagnostic { line: number; column: number; message: string; }
export interface MarkdownSourceController {
  read(): { content: string; diagnostic: MarkdownParseDiagnostic | null };
  view(): PageViewState;
  reveal(offset: number): void;
  ready(): boolean;
}

function sourceText(view: EditorView): string {
  const source = view.state.doc.toString();
  const separator = view.state.facet(EditorState.lineSeparator) ?? '\n';
  return separator === '\n' ? source : source.replace(/\n/g, separator);
}

function parseDiagnostic(view: EditorView): MarkdownParseDiagnostic | null {
  forceParsing(view, view.state.doc.length, 200);
  let offset: number | null = null;
  syntaxTree(view.state).iterate({ enter: (node) => {
    if (node.type.isError && offset === null) { offset = node.from; return false; }
  } });
  const sourceIssue = inspectMarkdownParse(sourceText(view));
  if (sourceIssue && (offset === null || sourceIssue.offset <= offset)) {
    return { line: sourceIssue.line, column: sourceIssue.column, message: sourceIssue.message };
  }
  if (offset === null) return null;
  const line = view.state.doc.lineAt(offset);
  return { line: line.number, column: offset - line.from + 1, message: 'El parser Markdown encontró una construcción incompleta.' };
}

export function MarkdownSourceEditor({ value, editable, controllerRef, onChange, onDiagnostic, initialView, onViewChange, onReady }: {
  value: string; editable: boolean; controllerRef: React.MutableRefObject<MarkdownSourceController | null>;
  onChange: (value: string) => void; onDiagnostic: (value: MarkdownParseDiagnostic | null) => void;
  initialView?: PageViewState; onViewChange?: (view: PageViewState) => void;
  onReady?: () => void;
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const current = useRef<EditorView | null>(null), permissions = useRef(new Compartment());
  const callbacks = useRef({ onChange, onDiagnostic, onViewChange });
  callbacks.current = { onChange, onDiagnostic, onViewChange };
  useEffect(() => {
    if (!host.current) return;
    let lastView: PageViewState = initialView ?? { mode: 'source', scrollTop: 0, scrollLeft: 0, selection: null };
    let restoring = true;
    const lineSeparator = value.includes('\r\n') ? '\r\n' : '\n';
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup, markdown(), EditorView.cspNonce.of(editorStyleNonce()), EditorState.lineSeparator.of(lineSeparator), permissions.current.of([EditorState.readOnly.of(!editable), EditorView.editable.of(editable)]), EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': 'Fuente Markdown de la página', tabindex: '0' }),
          EditorView.updateListener.of((update) => {
            if (update.selectionSet && !restoring) callbacks.current.onViewChange?.(capture());
            if (!update.docChanged) return;
            callbacks.current.onChange(sourceText(update.view));
            callbacks.current.onDiagnostic(parseDiagnostic(update.view));
          })
        ]
      })
    });
    function capture(): PageViewState {
      if (restoring || !view.dom.getClientRects().length) return lastView;
      return lastView = { mode: 'source', scrollTop: view.scrollDOM.scrollTop, scrollLeft: view.scrollDOM.scrollLeft,
        selection: { anchor: view.state.selection.main.anchor, head: view.state.selection.main.head } };
    }
    const scroll = (): void => { if (!restoring) callbacks.current.onViewChange?.(capture()); };
    current.current = view; view.scrollDOM.addEventListener('scroll', scroll);
    controllerRef.current = { read: () => ({ content: sourceText(view), diagnostic: parseDiagnostic(view) }), view: capture, ready: () => !restoring,
      reveal: (offset) => { const at = Math.min(view.state.doc.length, sourceText(view).slice(0, offset).replace(/\r\n/g, '\n').length); view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) }); view.focus(); } };
    callbacks.current.onDiagnostic(parseDiagnostic(view));
    const frame = requestAnimationFrame(() => {
      if (initialView?.mode === 'source' && initialView.selection) view.dispatch({ selection: { anchor: Math.min(view.state.doc.length, initialView.selection.anchor), head: Math.min(view.state.doc.length, initialView.selection.head) } });
      if (editable) view.focus();
      view.scrollDOM.scrollTop = initialView?.scrollTop ?? 0; view.scrollDOM.scrollLeft = initialView?.scrollLeft ?? 0;
      restoring = false;
      onReady?.();
    });
    return () => { cancelAnimationFrame(frame); callbacks.current.onViewChange?.(capture()); controllerRef.current = null; current.current = null; callbacks.current.onDiagnostic(null); view.scrollDOM.removeEventListener('scroll', scroll); view.destroy(); };
  // The component is mounted for one source-mode session; parent state receives each document change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { current.current?.dispatch({ effects: permissions.current.reconfigure([EditorState.readOnly.of(!editable), EditorView.editable.of(editable)]) }); }, [editable]);
  return <div ref={host} className="markdown-source-editor" data-markdown-source-editor aria-label="Fuente Markdown" />;
}
