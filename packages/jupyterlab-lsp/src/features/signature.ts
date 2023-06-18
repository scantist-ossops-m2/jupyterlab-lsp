import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { IEditorExtensionRegistry, EditorExtensionRegistry } from '@jupyterlab/codemirror';
import { EditorView } from '@codemirror/view';
import { ChangeSet, Text } from "@codemirror/state"
import {
  IEditorPosition,
  IRootPosition,
  offsetAtPosition,
  positionAtOffset,
  ILSPFeatureManager,
  ILSPDocumentConnectionManager,
  WidgetLSPAdapter
} from '@jupyterlab/lsp';
import { IRenderMimeRegistry } from '@jupyterlab/rendermime';
import { ISettingRegistry } from '@jupyterlab/settingregistry';
import * as lsProtocol from 'vscode-languageserver-protocol';

import { CodeSignature as LSPSignatureSettings } from '../_signature';
import { EditorTooltipManager } from '../components/free_tooltip';
import { PositionConverter, rootPositionToVirtualPosition } from '../converter';
import { ILSPDocumentConnectionManager as ILSPDocumentConnectionManagerDownstream } from '../connection_manager'
import { BrowserConsole } from '../virtual/console';
import { FeatureSettings, Feature } from '../feature';
import { ILogConsoleCore, PLUGIN_ID } from '../tokens';
import { escapeMarkdown } from '../utils';

const TOOLTIP_ID = 'signature';
const CLASS_NAME = 'lsp-signature-help';

function getMarkdown(item: string | lsProtocol.MarkupContent) {
  if (typeof item === 'string') {
    return escapeMarkdown(item);
  } else {
    if (item.kind === 'markdown') {
      return item.value;
    } else {
      return escapeMarkdown(item.value);
    }
  }
}

interface ISplit {
  lead: string;
  remainder: string;
}

export function extractLead(lines: string[], size: number): ISplit | null {
  // try to split after paragraph
  const leadLines = [];
  let splitOnParagraph = false;

  for (const line of lines.slice(0, size + 1)) {
    const isEmpty = line.trim() == '';
    if (isEmpty) {
      splitOnParagraph = true;
      break;
    }
    leadLines.push(line);
  }
  // see if we got something which does not include Markdown formatting
  // (so it won't lead to broken formatting if we split after it);
  const leadCandidate = leadLines.join('\n');

  if (splitOnParagraph && leadCandidate.search(/[\\*#[\]<>_]/g) === -1) {
    return {
      lead: leadCandidate,
      remainder: lines.slice(leadLines.length + 1).join('\n')
    };
  }
  return null;
}

/**
 * Represent signature as a Markdown element.
 */
export function signatureToMarkdown(
  item: lsProtocol.SignatureInformation,
  language: string = '',
  codeHighlighter: (
    source: string,
    variable: string,
    language: string
  ) => string,
  logger: ILogConsoleCore,
  activeParameterFallback?: number | null,
  maxLinesBeforeCollapse: number = 4
): string {
  const activeParameter: number | undefined | null =
    typeof item.activeParameter !== 'undefined'
      ? item.activeParameter
      : activeParameterFallback;
  let markdown: string;
  let label = item.label;
  if (item.parameters && activeParameter != null) {
    if (activeParameter > item.parameters.length) {
      logger.error(
        'LSP server returned wrong number for activeSignature for: ',
        item
      );
      markdown = '```' + language + '\n' + label + '\n```';
    } else {
      const parameter = item.parameters[activeParameter];
      let substring: string =
        typeof parameter.label === 'string'
          ? parameter.label
          : label.slice(parameter.label[0], parameter.label[1]);
      markdown = codeHighlighter(label, substring, language);
    }
  } else {
    markdown = '```' + language + '\n' + label + '\n```';
  }
  let details = '';
  if (item.documentation) {
    if (
      typeof item.documentation === 'string' ||
      item.documentation.kind === 'plaintext'
    ) {
      const plainTextDocumentation =
        typeof item.documentation === 'string'
          ? item.documentation
          : item.documentation.value;
      // TODO: make use of the MarkupContent object instead
      for (let line of plainTextDocumentation.split('\n')) {
        if (line.trim() === item.label.trim()) {
          continue;
        }

        details += getMarkdown(line) + '\n';
      }
    } else {
      if (item.documentation.kind !== 'markdown') {
        logger.warn('Unknown MarkupContent kind:', item.documentation.kind);
      }
      details += item.documentation.value;
    }
  } else if (item.parameters) {
    details +=
      '\n\n' +
      item.parameters
        .filter(parameter => parameter.documentation)
        .map(parameter => '- ' + getMarkdown(parameter.documentation!))
        .join('\n');
  }
  if (details) {
    const lines = details.trim().split('\n');
    if (lines.length > maxLinesBeforeCollapse) {
      const split = extractLead(lines, maxLinesBeforeCollapse);
      if (split) {
        details =
          split.lead + '\n<details>\n' + split.remainder + '\n</details>';
      } else {
        details = '<details>\n' + details + '\n</details>';
      }
    }
    markdown += '\n\n' + details;
  } else {
    markdown += '\n';
  }
  return markdown;
}


function extractLastCharacter(changes: ChangeSet): string {
  // TODO test with pasting, maybe rewrite to retrieve based on cursor position.
  let last = '';
  changes.iterChanges((fromA: number, toA: number, fromB: number, toB: number, inserted: Text) => {
    last = inserted.sliceString(-1);
  })
  return last;
}


export class SignatureFeature extends Feature {
  readonly id = SignatureFeature.id;
  readonly capabilities: lsProtocol.ClientCapabilities = {
    textDocument: {
      signatureHelp: {
        dynamicRegistration: true,
        signatureInformation: {
          documentationFormat: ['markdown', 'plaintext']
        }
      }
    }
  }
  tooltip: EditorTooltipManager;

  protected signatureCharacter: IRootPosition;
  protected _signatureCharacters: string[];
  protected console = new BrowserConsole().scope('Signature');
  protected settings: FeatureSettings<LSPSignatureSettings>;

  constructor(options: SignatureFeature.IOptions) {
    super(options);
    this.settings = new FeatureSettings(options.settingRegistry, this.id);
    this.tooltip = new EditorTooltipManager(options.renderMimeRegistry);
    const connectionManager = options.connectionManager;
    options.editorExtensionRegistry.addExtension({
      name: 'lsp:codeSignature',
      factory: (options) => {
        const updateListener = EditorView.updateListener.of((viewUpdate) => {
          if (!viewUpdate.docChanged && viewUpdate.selectionSet) {
            console.log('neither doc changed nor selection changed');
            return;
          }

          const adapter = connectionManager.adapterByModel.get(options.model);

          if (!adapter) {
            throw Error('[signature] no adapter for model aborting');
          }

          const editorAccessor = adapter.activeEditor;

          const editor = editorAccessor!.getEditor()!;

          // TODO: or should it come from viewUpdate instead?!
          // especially on copy paste this can be problematic.
          const position = editor.getCursorPosition();

          const editorPosition = {
            line: position.line,
            ch: position.column
          } as IEditorPosition

          if (viewUpdate.selectionSet) {
            this.onCursorActivity(adapter, editorPosition);
          } else {
            this.afterChange(viewUpdate.changes, adapter, editorPosition);
          }
        });

        const focusListener = EditorView.domEventHandlers({
          focus: () => {
            // TODO
            // this.onCursorActivity()
          },
          blur: (event) => {
            this.onBlur(event)
          }
        });

        return EditorExtensionRegistry.createImmutableExtension([updateListener, focusListener]);
      }
    });
  }

  get _closeCharacters(): string[] {
    if (!this.settings) {
      return [];
    }
    return this.settings.composite.closeCharacters;
  }

  onBlur(event: FocusEvent) {
    // hide unless the focus moved to the signature itself
    // (allowing user to select/copy from signature)
    if (
      this.isSignatureShown() &&
      (event.relatedTarget as Element).closest('.' + CLASS_NAME) === null
    ) {
      this._removeTooltip();
    }
  }

  onCursorActivity(adapter: WidgetLSPAdapter<any>, newEditorPosition: IEditorPosition) {
    if (!this.isSignatureShown()) {
      return;
    }

    const initialPosition = this.tooltip.position;
    if (
      newEditorPosition.line === initialPosition.line &&
      newEditorPosition.ch < initialPosition.ch
    ) {
      // close tooltip if receded beyond starting position
      this._removeTooltip();
    } else {
      // otherwise, update the signature as the active parameter could have changed,
      // or the server may want us to close the tooltip
      this.requestSignature(adapter, newEditorPosition, initialPosition)?.catch(
        this.console.warn
      );
    }
  }

  protected get_markup_for_signature_help(
    response: lsProtocol.SignatureHelp,
    language: string = ''
  ): lsProtocol.MarkupContent {
    let signatures = new Array<string>();

    if (response.activeSignature != null) {
      if (response.activeSignature >= response.signatures.length) {
        this.console.error(
          'LSP server returned wrong number for activeSignature for: ',
          response
        );
      } else {
        const item = response.signatures[response.activeSignature];
        return {
          kind: 'markdown',
          value: this.signatureToMarkdown(
            item,
            language,
            response.activeParameter
          )
        };
      }
    }

    response.signatures.forEach(item => {
      let markdown = this.signatureToMarkdown(item, language);
      signatures.push(markdown);
    });

    return {
      kind: 'markdown',
      value: signatures.join('\n\n')
    };
  }

  protected highlightCode(source: string, variable: string, language: string) {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    pre.appendChild(code);
    code.className = `cm-s-jupyter language-${language}`;
    // TODO
    // temp workaround
    code.innerText = source;
    /**
    this.codeMirror.CodeMirror.runMode(
      source,
      language,
      (token: string, className: string) => {
        let element: HTMLElement | Node;
        if (className) {
          element = document.createElement('span');
          (element as HTMLElement).classList.add('cm-' + className);
          element.textContent = token;
        } else {
          element = document.createTextNode(token);
        }
        if (className === 'variable' && token === variable) {
          const mark = document.createElement('mark');
          mark.appendChild(element);
          element = mark;
        }
        code.appendChild(element);
      }
    );
    **/
    return pre.outerHTML;
  }

  /**
   * Represent signature as a Markdown element.
   */
  protected signatureToMarkdown(
    item: lsProtocol.SignatureInformation,
    language: string,
    activeParameterFallback?: number | null
  ): string {
    return signatureToMarkdown(
      item,
      language,
      this.highlightCode.bind(this),
      this.console,
      activeParameterFallback,
      this.settings.composite.maxLines
    );
  }

  private _removeTooltip() {
    this.tooltip.remove();
  }

  private _hideTooltip() {
    this.tooltip.hide();
  }

  private handleSignature(
    response: lsProtocol.SignatureHelp,
    adapter: WidgetLSPAdapter<any>,
    positionAtRequest: IRootPosition,
    displayPosition: IEditorPosition | null = null
  ) {
    this.console.log('Signature received', response);

    const virtualDocument = adapter.virtualDocument!;
    const connection = this.connectionManager.connections.get(virtualDocument.uri)!;
    // @ts-ignore
    const signatureCharacters: string[] = connection.serverCapabilities?.signatureHelpProvider?.triggerCharacters;

    if (response === null) {
      // do not hide on undefined as it simply indicates that no new info is available
      // (null means close, undefined means no update, response means update)
      this._removeTooltip();
    } else if (response) {
      this._hideTooltip();
    }

    if (!this.signatureCharacter || !response || !response.signatures.length) {
      if (response) {
        this._removeTooltip();
      }
      this.console.debug(
        'Ignoring signature response: cursor lost or response empty'
      );
      return;
    }

    // TODO: helper?
    const pos = adapter.activeEditor!.getEditor()!.getCursorPosition();
    const rootPosition = {ch: pos.column, line: pos.line} as IRootPosition;

    // if the cursor advanced in the same line, the previously retrieved signature may still be useful
    // if the line changed or cursor moved backwards then no reason to keep the suggestions
    if (
      positionAtRequest.line != rootPosition.line ||
      rootPosition.ch < positionAtRequest.ch
    ) {
      this.console.debug(
        'Ignoring signature response: cursor has receded or changed line'
      );
      this._removeTooltip();
      return;
    }

    const virtualPosition = rootPositionToVirtualPosition(virtualDocument, rootPosition);

    let editorAccessor = adapter.editors[adapter.getEditorIndexAt(virtualPosition)].ceEditor;
    const cm_editor = editorAccessor.getEditor();
    if (!cm_editor) {
      this.console.debug(
        'Ignoring signature response: the corresponding editor is not loaded'
      );
      return;
    }
    if (!cm_editor.hasFocus()) {
      this.console.debug(
        'Ignoring signature response: the corresponding editor lost focus'
      );
      this._removeTooltip();
      return;
    }
    let editorPosition =
      virtualDocument.transformVirtualToEditor(virtualPosition);

    // TODO: restore language probing
    // let language = cm_editor.getModeAt(editorPosition).name;
    let language = 'python';
    let markup = this.get_markup_for_signature_help(response, language);

    this.console.log(
      'Signature will be shown',
      language,
      markup,
      rootPosition,
      response
    );
    if (displayPosition === null) {
      // try to find last occurrance of trigger character to position the tooltip
      const content = cm_editor.model.sharedModel.getSource();
      const lines = content.split('\n');
      const offset = offsetAtPosition(
        PositionConverter.cm_to_ce(editorPosition!),
        lines
      );
      // maybe?
      // const offset = cm_editor.getOffsetAt(PositionConverter.cm_to_ce(editorPosition));
      const subset = content.substring(0, offset);
      const lastTriggerCharacterOffset = Math.max(
        ...signatureCharacters.map(character =>
          subset.lastIndexOf(character)
        )
      );
      if (lastTriggerCharacterOffset !== -1) {
        displayPosition = PositionConverter.ce_to_cm(
          positionAtOffset(lastTriggerCharacterOffset, lines)
        ) as IEditorPosition;
      } else {
        displayPosition = editorPosition;
      }
    }
    this.tooltip.showOrCreate({
      markup,
      position: displayPosition!,
      id: TOOLTIP_ID,
      ceEditor: cm_editor,
      adapter: adapter,
      className: CLASS_NAME,
      tooltip: {
        privilege: 'forceAbove',
        // do not move the tooltip to match the token to avoid drift of the
        // tooltip due the simplicty of token matching rules; instead we keep
        // the position constant manually via `displayPosition`.
        alignment: undefined,
        hideOnKeyPress: false
      }
    });
  }

  protected isSignatureShown() {
    return this.tooltip.isShown(TOOLTIP_ID);
  }

  afterChange(change: ChangeSet, adapter: WidgetLSPAdapter<any>, editorPosition: IEditorPosition) {
    const lastCharacter = extractLastCharacter(change);

    const isSignatureShown = this.isSignatureShown();
    let previousPosition: IEditorPosition | null = null;

    if (isSignatureShown) {
      previousPosition = this.tooltip.position;
      if (this._closeCharacters.includes(lastCharacter)) {
        // remove just in case but do not short-circuit in case if we need to re-trigger
        this._removeTooltip();
      }
    }

    const virtualDocument = adapter.virtualDocument!;
    const connection = this.connectionManager.connections.get(virtualDocument.uri)!;
    // @ts-ignore
    const signatureCharacters = connection.serverCapabilities?.signatureHelpProvider?.triggerCharacters;

    // only proceed if: trigger character was used or the signature is/was visible immediately before
    if (
      !(signatureCharacters.includes(lastCharacter) || isSignatureShown)
    ) {
      return;
    }

    this.requestSignature(adapter, editorPosition, previousPosition)?.catch(
      this.console.warn
    );
  }

  private requestSignature(
    adapter: WidgetLSPAdapter<any>,
    newEditorPosition: IEditorPosition,
    previousPosition: IEditorPosition | null
  ) {
    // TODO: why would virtual document be missing?
    const virtualDocument = adapter.virtualDocument!;
    const connection = this.connectionManager.connections.get(virtualDocument.uri)!;

    if (
      !(
        connection.isReady &&
        // @ts-ignore
        connection.serverCapabilities?.signatureHelpProvider
      )
    ) {
      return;
    }

    // TODO: why missing
    const rootPosition = virtualDocument.transformFromEditorToRoot(adapter.activeEditor!, newEditorPosition)!;

    this.signatureCharacter = rootPosition;

    const virtualPosition = rootPositionToVirtualPosition(virtualDocument, rootPosition);

    return connection.clientRequests['textDocument/signatureHelp']
      .request({
        position: {
          line: virtualPosition.line,
          character: virtualPosition.ch
        },
        textDocument: {
          uri: virtualDocument.documentInfo.uri
        }
      })
      .then(help =>
        this.handleSignature(help, adapter, rootPosition, previousPosition)
      );
  }
}

export namespace SignatureFeature {
  export interface IOptions extends Feature.IOptions {
    settingRegistry: ISettingRegistry;
    renderMimeRegistry: IRenderMimeRegistry;
    editorExtensionRegistry: IEditorExtensionRegistry;
  }
  export const id = PLUGIN_ID + ':signature';
}


export const SIGNATURE_PLUGIN: JupyterFrontEndPlugin<void> = {
  id: SignatureFeature.id,
  requires: [
    ILSPFeatureManager,
    ISettingRegistry,
    IRenderMimeRegistry,
    IEditorExtensionRegistry,
    ILSPDocumentConnectionManager
  ],
  autoStart: true,
  activate: (
    app: JupyterFrontEnd,
    featureManager: ILSPFeatureManager,
    settingRegistry: ISettingRegistry,
    renderMimeRegistry: IRenderMimeRegistry,
    editorExtensionRegistry: IEditorExtensionRegistry,
    connectionManager: ILSPDocumentConnectionManagerDownstream
  ) => {
    const feature = new SignatureFeature({
      settingRegistry,
      connectionManager,
      renderMimeRegistry,
      editorExtensionRegistry
    });
    featureManager.register(feature);
    // return feature;
  }
};
