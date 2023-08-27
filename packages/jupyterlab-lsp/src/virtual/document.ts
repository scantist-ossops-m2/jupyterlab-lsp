// TODO: develop a better API upstream
import { CodeEditor } from '@jupyterlab/codeeditor';
import type {
  IVirtualPosition,
  IRootPosition,
  Document,
  ForeignDocumentsMap
} from '@jupyterlab/lsp';
import { VirtualDocument as VirtualDocumentBase } from '@jupyterlab/lsp';

import { ReversibleOverridesMap } from '../overrides/maps';
import { ICodeOverridesRegistry } from '../overrides/tokens';

export namespace VirtualDocument {
  export interface IOptions extends VirtualDocumentBase.IOptions {
    overridesRegistry: ICodeOverridesRegistry;
  }
}

export class VirtualDocument extends VirtualDocumentBase {
  private cellMagicsOverrides: ReversibleOverridesMap;
  private lineMagicsOverrides: ReversibleOverridesMap;

  constructor(options: VirtualDocument.IOptions) {
    super(options);
    const overrides =
      this.language in options.overridesRegistry
        ? options.overridesRegistry[this.language]
        : null;
    this.cellMagicsOverrides = new ReversibleOverridesMap(
      overrides ? overrides.cell : []
    );
    this.lineMagicsOverrides = new ReversibleOverridesMap(
      overrides ? overrides.line : []
    );
  }

  // TODO: this could be moved out
  decodeCodeBlock(rawCode: string): string {
    // TODO: add back previously extracted foreign code
    const cellOverride = this.cellMagicsOverrides.reverse.overrideFor(rawCode);
    if (cellOverride != null) {
      return cellOverride;
    } else {
      let lines = this.lineMagicsOverrides.reverseReplaceAll(
        rawCode.split('\n')
      );
      return lines.join('\n');
    }
  }

  /**
   * Extends parent method to hook cell magics overrides.
   */
  prepareCodeBlock(
    block: Document.ICodeBlockOptions,
    editorShift: CodeEditor.IPosition = { line: 0, column: 0 }
  ) {
    let lines: Array<string>;
    let skipInspect: Array<Array<VirtualDocumentBase.idPath>>;

    let { cellCodeKept, foreignDocumentsMap } = this.extractForeignCode(
      block,
      editorShift
    );
    const cellCode = cellCodeKept;

    // cell magics are replaced if requested and matched
    const cellOverride = this.cellMagicsOverrides.overrideFor(cellCode);
    if (cellOverride != null) {
      lines = cellOverride.split('\n');
      skipInspect = lines.map(_line => [this.idPath]);
    } else {
      // otherwise, we replace line magics - if any
      let result = this.lineMagicsOverrides.replaceAll(cellCode.split('\n'));
      lines = result.lines;
      skipInspect = result.skipInspect.map(skip => (skip ? [this.idPath] : []));
    }

    return { lines, foreignDocumentsMap, skipInspect };
  }

  /**
   * @experimental
   */
  transformVirtualToRoot(position: IVirtualPosition): IRootPosition | null {
    // a method which was previously implemented in CodeMirrorIntegration
    // but probably should have been in VirtualDocument all along
    let editor = this.virtualLines.get(position.line)!.editor;
    let editorPosition = this.transformVirtualToEditor(position);
    return this.transformFromEditorToRoot(editor, editorPosition!);
  }

  /**
   * @experimental
   */
  getForeignDocuments(editorAccessor: Document.IEditor): ForeignDocumentsMap[] {
    let maps = new Set<ForeignDocumentsMap>();
    for (let line of this.sourceLines.values()) {
      if (line.editor === editorAccessor) {
        maps.add(line.foreignDocumentsMap);
      }
    }
    return [...maps.values()];
  }
}
