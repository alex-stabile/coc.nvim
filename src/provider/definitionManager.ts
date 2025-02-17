'use strict'
import { v4 as uuid } from 'uuid'
import { CancellationToken, DefinitionLink, Disposable, DocumentSelector, LocationLink, Position } from 'vscode-languageserver-protocol'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { LocationWithTarget } from '../types'
import { DefinitionProvider } from './index'
import Manager from './manager'
const logger = require('../util/logger')('definitionManager')

export default class DefinitionManager extends Manager<DefinitionProvider> {

  public register(selector: DocumentSelector, provider: DefinitionProvider): Disposable {
    return this.addProvider({
      id: uuid(),
      selector,
      provider
    })
  }

  public async provideDefinition(
    document: TextDocument,
    position: Position,
    token: CancellationToken
  ): Promise<LocationWithTarget[]> {
    const providers = this.getProviders(document)
    let locations: LocationWithTarget[] = []
    const results = await Promise.allSettled(providers.map(item => {
      return Promise.resolve(item.provider.provideDefinition(document, position, token)).then(location => {
        this.addLocation(locations, location)
      })
    }))
    this.handleResults(results, 'provideDefinition')
    return locations
  }

  public async provideDefinitionLinks(
    document: TextDocument,
    position: Position,
    token: CancellationToken
  ): Promise<DefinitionLink[]> {
    const providers = this.getProviders(document)
    let locations: DefinitionLink[] = []
    const results = await Promise.allSettled(providers.map(item => {
      return Promise.resolve(item.provider.provideDefinition(document, position, token)).then(location => {
        if (Array.isArray(location)) {
          location.forEach(loc => {
            if (LocationLink.is(loc)) {
              locations.push(loc)
            }
          })
        }
      })
    }))
    this.handleResults(results, 'provideDefinition')
    return locations
  }
}
