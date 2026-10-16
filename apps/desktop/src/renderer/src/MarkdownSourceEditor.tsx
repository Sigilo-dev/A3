import { useEffect, useRef } from 'react';
import { markdown } from '@codemirror/lang-markdown';
import { forceParsing, syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { basicSetup, EditorView } from 'codemirror';
import { inspectMarkdownParse } from '@a3/domain/markdown';

export interface MarkdownParseDiagnostic { line: number; column: number; message: string; }
export interface MarkdownSourceController {
  read(): { content: string; diagnostic: MarkdownParseDiagnostic | null };
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

export function MarkdownSourceEditor({ value, editable, controllerRef, onChange, onDiagnostic }: {
  value: string; editable: boolean; controllerRef: React.MutableRefObject<MarkdownSourceController | null>;
  onChange: (value: string) => void; onDiagnostic: (value: MarkdownParseDiagnostic | null) => void;
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onChange, onDiagnostic });
  callbacks.current = { onChange, onDiagnostic };
  useEffect(() => {
    if (!host.current) return;
    const lineSeparator = value.includes('\r\n') ? '\r\n' : '\n';
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup, markdown(), EditorState.lineSeparator.of(lineSeparator), EditorState.readOnly.of(!editable),
          EditorView.editable.of(editable), EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            callbacks.current.onChange(sourceText(update.view));
            callbacks.current.onDiagnostic(parseDiagnostic(update.view));
          })
        ]
      })
    });
    controllerRef.current = { read: () => ({ content: sourceText(view), diagnostic: parseDiagnostic(view) }) };
    callbacks.current.onDiagnostic(parseDiagnostic(view));
    if (editable) view.focus();
    return () => { controllerRef.current = null; callbacks.current.onDiagnostic(null); view.destroy(); };
  // The component is mounted for one source-mode session; parent state receives each document change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div ref={host} className="markdown-source-editor" data-markdown-source-editor aria-label="Fuente Markdown" />;
}
