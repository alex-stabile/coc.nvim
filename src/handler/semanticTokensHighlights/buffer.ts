import { Buffer, Neovim } from '@chemzqm/neovim'
import debounce from 'debounce'
import { CancellationTokenSource, Range, SemanticTokens, SemanticTokensDelta, uinteger } from 'vscode-languageserver-protocol'
import languages from '../../languages'
import { SyncItem } from '../../model/bufferSync'
import Document from '../../model/document'
import { HighlightItem, HighlightItemOption } from '../../types'
import workspace from '../../workspace'
const logger = require('../../util/logger')('semanticTokens-buffer')

const HLGROUP_PREFIX = 'CocSem_'
/**
 * Relative highlight
 */
interface RelativeHighlight {
  tokenType: string
  tokenModifiers: string[]
  deltaLine: number
  deltaStartCharacter: number
  length: number
}

export interface SemanticTokensConfig {
  filetypes: string[]
}

interface SemanticTokensPreviousResult {
  readonly version: number
  readonly resultId: string | undefined,
  readonly tokens?: uinteger[],
}

export const NAMESPACE = 'semanticTokens'

export default class SemanticTokensBuffer implements SyncItem {
  private tokenSource: CancellationTokenSource
  private _highlights: HighlightItem[]
  private previousResults: SemanticTokensPreviousResult
  public highlight: Function & { clear(): void }
  constructor(
    private nvim: Neovim,
    public readonly bufnr: number,
    private readonly config: SemanticTokensConfig) {
    this.highlight = debounce(() => {
      this.doHighlight().logError()
    }, global.hasOwnProperty('__TEST__') ? 10 : 500)
    this.highlight()
  }

  public onChange(): void {
    this.cancel()
    this.highlight()
  }

  public async forceHighlight(): Promise<void> {
    this.cancel()
    this.highlight.clear()
    await this.doHighlight()
  }

  /**
   * Get current highlight items
   */
  public get highlights(): ReadonlyArray<HighlightItem> {
    return this._highlights
  }

  public get enabled(): boolean {
    if (!this.config.filetypes.length) return false
    let doc = workspace.getDocument(this.bufnr)
    if (!doc || !doc.attached) return false
    if (!this.config.filetypes.includes(doc.filetype)) return false
    return languages.hasProvider('semanticTokens', doc.textDocument)
  }

  public get previousVersion(): number | undefined {
    if (!this.previousResults) return undefined
    return this.previousResults.version
  }

  private get buffer(): Buffer {
    return this.nvim.createBuffer(this.bufnr)
  }

  public checkState(): void {
    if (!this.config.filetypes.length) throw new Error('No filetypes enabled for semanticTokens highlight')
    let doc = workspace.getDocument(this.bufnr)
    if (!doc || !doc.attached) throw new Error('Document not attached')
    if (!this.config.filetypes.includes(doc.filetype)) throw new Error('SemanticTokens highlight is not enabled for current filetype')
    if (!languages.hasProvider('semanticTokens', doc.textDocument)) throw new Error('SemanticTokens provider not found, your languageserver may not support it')
  }

  public setState(enabled: boolean): void {
    if (enabled) {
      this.highlight()
    } else {
      this.highlight.clear()
      this.clearHighlight()
    }
  }

  private async doHighlight(): Promise<void> {
    if (!this.enabled) return
    let doc = workspace.getDocument(this.bufnr)
    const items = await this.requestHighlights(doc)
    // request cancelled or can't work
    if (!items) return
    const { nvim } = this
    nvim.pauseNotification()
    this.buffer.updateHighlights(NAMESPACE, items, { priority: 4096 })
    if (workspace.isVim) nvim.command('redraw', true)
    void nvim.resumeNotification(false, true)
  }

  /**
   * Request highlights from provider, return undefined when can't request or request cancelled
   * TODO use range provider as well
   */
  private async requestHighlights(doc: Document, forceFull?: boolean): Promise<HighlightItem[] | undefined> {
    const legend = languages.getLegend(doc.textDocument)
    if (!legend) return undefined
    this.cancel()
    this.tokenSource = new CancellationTokenSource()
    const { token } = this.tokenSource
    const hasEditProvider = languages.hasSemanticTokensEdits(doc.textDocument)
    const previousResult = forceFull ? null : this.previousResults
    let result: SemanticTokens | SemanticTokensDelta
    let version = doc.textDocument.version
    if (hasEditProvider && previousResult?.resultId) {
      result = await languages.provideDocumentSemanticTokensEdits(doc.textDocument, previousResult.resultId, token)
    } else {
      result = await languages.provideDocumentSemanticTokens(doc.textDocument, token)
    }
    this.tokenSource = null
    if (token.isCancellationRequested || !result) return undefined

    let tokens: uinteger[] = []
    if (SemanticTokens.is(result)) {
      tokens = result.data
    } else {
      tokens = previousResult.tokens
      result.edits.forEach(e => {
        if (e.deleteCount > 0) {
          tokens.splice(e.start, e.deleteCount, ...e.data)
        } else {
          tokens.splice(e.start, 0, ...e.data)
        }
      })
    }
    this.previousResults = { resultId: result.resultId, tokens, version }
    const relatives: RelativeHighlight[] = []
    for (let i = 0; i < tokens.length; i += 5) {
      const deltaLine = tokens[i]
      const deltaStartCharacter = tokens[i + 1]
      const length = tokens[i + 2]
      const tokenType = tokens[i + 3]
      const tokenModifiers = legend.tokenModifiers.filter((_, m) => tokens[i + 4] & (1 << m))
      relatives.push({ tokenType: legend.tokenTypes[tokenType], tokenModifiers, deltaLine, deltaStartCharacter, length })
    }

    const res: HighlightItem[] = []
    let currentLine = 0
    let currentCharacter = 0
    for (const {
      tokenType,
      deltaLine,
      deltaStartCharacter,
      length
    } of relatives) {
      const lnum = currentLine + deltaLine
      const startCharacter = deltaLine === 0 ? currentCharacter + deltaStartCharacter : deltaStartCharacter
      const endCharacter = startCharacter + length
      currentLine = lnum
      currentCharacter = startCharacter
      let range = Range.create(lnum, startCharacter, lnum, endCharacter)
      let hlGroup = HLGROUP_PREFIX + tokenType
      let opts: HighlightItemOption = { combine: false }
      if (tokenType === 'variable' || tokenType === 'string') {
        opts.end_incl = true
        opts.start_incl = true
      }
      doc.addHighlights(res, hlGroup, range, opts)
    }
    this._highlights = res
    return res
  }

  public clearHighlight(): void {
    this.buffer.clearNamespace(NAMESPACE)
  }

  public cancel(): void {
    if (this.tokenSource) {
      this.tokenSource.cancel()
      this.tokenSource.dispose()
      this.tokenSource = null
    }
  }

  public dispose(): void {
    this.highlight.clear()
    this.previousResults = undefined
    this.cancel()
  }
}
