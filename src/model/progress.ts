'use strict'
import { Neovim } from '@chemzqm/neovim'
import Notification, { NotificationPreferences } from './notification'
import { CancellationToken, CancellationTokenSource, Event, Emitter } from 'vscode-languageserver-protocol'
import events from '../events'
const logger = require('../util/logger')('model-progress')

export interface Progress {
  report(value: { message?: string; increment?: number }): void
}

export interface ProgressOptions<R> {
  title?: string
  cancellable?: boolean
  task: (progress: Progress, token: CancellationToken) => Thenable<R>
}

export function formatMessage(title: string | undefined, message: string | undefined, total: number) {
  let parts = []
  if (title) parts.push(title)
  if (message) parts.push(message)
  if (total) parts.push(total + '%')
  return parts.join(' ')
}

export default class ProgressNotification<R> extends Notification {
  private tokenSource: CancellationTokenSource
  private readonly _onDidFinish = new Emitter<R>()
  public readonly onDidFinish: Event<R> = this._onDidFinish.event
  constructor(nvim: Neovim, private option: ProgressOptions<R>) {
    super(nvim, {
      kind: 'progress',
      title: option.title,
      buttons: option.cancellable ? [{ index: 1, text: 'Cancel' }] : undefined
    }, false)
    this.disposables.push(this._onDidFinish)
    events.on('BufWinLeave', bufnr => {
      if (bufnr == this.bufnr) {
        if (this.tokenSource) this.tokenSource.cancel()
        this._onDidFinish.fire(undefined)
        this._winid = undefined
        this.dispose()
      }
    }, null, this.disposables)
  }

  public async show(preferences: Partial<NotificationPreferences>): Promise<void> {
    let { task } = this.option
    let tokenSource = this.tokenSource = new CancellationTokenSource()
    this.disposables.push(tokenSource)
    let total = 0
    if (this.config.buttons || !preferences.disabled) {
      await super.show(preferences)
    } else {
      logger.warn(`progress window disabled by "notification.disabledProgressSources"`)
    }
    task({
      report: p => {
        if (!this.winid) return
        let { nvim } = this
        if (p.increment) {
          total += p.increment
          nvim.call('coc#window#set_var', [this.winid, 'percent', `${total}%`], true)
        }
        if (p.message) nvim.call('coc#window#set_var', [this.winid, 'message', p.message.replace(/\r?\n/g, ' ')], true)
      }
    }, tokenSource.token).then(res => {
      if (this._disposed) return
      this._onDidFinish.fire(res)
      this.dispose()
    }, err => {
      if (this._disposed) return
      if (err) this.nvim.echoError(err)
      this._onDidFinish.fire(undefined)
      this.dispose()
    })
  }
}
