import { Node, Store, BaseNode, NodeObserver, StoreObserver } from '.'
import yaml from 'yaml'


export interface FileSystem {
  read(filename: string): Promise<string>

  write(filename: string, contents: string): Promise<void>

  getFiles(): Promise<string[]>

  createFile(filename: string, contents?: string): Promise<void>
}


class NodeHelpers {
  static getValue(node: yaml.ast.MapBase, pred: (k: string, v: yaml.ast.Pair | yaml.ast.Merge) => boolean) {
    for (const item of node.items) {
      const key = item.key!!.toJSON()

      if (pred(key, item))
        return item.value
    }

    return null
  }

  static setValue(node: yaml.ast.MapBase, key: string, value: yaml.ast.AstNode) {
    for (const item of node.items) {
      if (item.key.toJSON() == key) {
        item.value = value
        return
      }
    }

    node.items.push((<yaml.ast.MapBase>yaml.createNode({ [key]: null })).items[0])
    node.items[node.items.length - 1].value = value
  }

  static getText(node: yaml.ast.MapBase) {
    return NodeHelpers.getValue(node, k => k == 'text' || k == 'title' || k == 'note')
  }

  static getNotes(node: yaml.ast.MapBase) {
    const notes = NodeHelpers.getValue(node,
                                       k => k == 'notes' || k == 'items' || k == 'children')
    return notes as yaml.ast.Seq
  }
}

export abstract class YamlFileOrChildNode {
  public abstract kind: 'file' | 'child'
  public abstract file: YamlFileNode

  private _seq: yaml.ast.SeqBase
  private _map: yaml.ast.MapBase

  constructor(public node: yaml.ast.MapBase | yaml.ast.AstNode) {
    if (node.type == 'MAP') {
      this._map = node
      this._seq = NodeHelpers.getNotes(node)
    }
  }

  get seq() {
    if (this._seq)
      return this._seq

    // we don't have children / we're a string
    if (this.node.type != 'MAP')
      this.node = <yaml.ast.MapBase>yaml.createNode({ text: this.node.toJSON(), children: [] })
    else
      this.node.items.push((<yaml.ast.MapBase>yaml.createNode({ children: [] })).items[0])

    return this._seq = NodeHelpers.getNotes(this.node)
  }

  get map() {
    if (this._map)
      return this._map

    return this.node = this._map = <yaml.ast.MapBase>yaml.createNode({ text: this.node.toJSON() })
  }
}

/**
 * A YAML node stored in its own file.
 */
export class YamlFileNode extends YamlFileOrChildNode {
  public kind: 'file' = 'file'
  public isDirty: boolean = true

  constructor(
    public filename: string,
    public document: yaml.ast.Document,
    public contents: string
  ) {
    super(document.contents)
  }

  get file() {
    return this
  }
}

/**
 * A child YAML node.
 */
export class YamlChildNode extends YamlFileOrChildNode {
  public kind: 'child' = 'child'

  constructor(
    public node: yaml.ast.MapBase | yaml.ast.AstNode,
    public textKind: 'plain' | 'property' | 'included',
    public file: YamlFileNode,
    public includedFile?: IncludedFile
  ) {
    super(node)
  }
}

export class IncludedFile {
  public kind: 'included' = 'included'
  public isDirty: boolean = true
  public nextContents: string

  constructor(
    public filename: string,
    public contents: string
  ) {}
}

export type YamlStoreState = { syntax: YamlFileNode | YamlChildNode }


class IncludeNode implements yaml.ast.Node {
  comment: string
  commentBefore: string
  cstNode?: yaml.cst.Node
  range: [number, number]
  tag: string

  type: 'INCLUDE' = 'INCLUDE'

  constructor(public filename: string) {}

  toJSON() {
    return { __include__: this.filename }
  }
}

const includeTag: yaml.Tag = {
  class  : Object,
  default: true,
  tag    : 'tag:yaml.org,2002:include',

  // @ts-ignore
  resolve: (doc, cstNode: yaml.cst.Node) => {
    if (cstNode.type != 'PLAIN')
      throw ''

    return new IncludeNode(cstNode.rawValue)
  },

  stringify: (item, ctx) => {
    return `!!include ${(item as any).value.filename}`
  }
}


/**
 * A `Store` that uses the file system and YAML files as backend.
 */
export class YamlStore implements Store<YamlStoreState> {
  private saveTimeout: NodeJS.Timeout

  public files: (YamlFileNode | IncludedFile)[] = []
  public root: Node<YamlStoreState>

  constructor(
    public fs       : FileSystem,
    public observers: NodeObserver<any>[],
    public throttleMs = Infinity
  ) {
    observers.push(this)
  }


  async load(filename: string): Promise<string[]> {
    const errors: string[] = []
    const ids = {}

    this.files.length = 0
    this.root = await BaseNode.createRoot<YamlStoreState>(this.observers, ids)

    for (const observer of this.observers) {
      const obs = observer as any as StoreObserver<any>

      if (typeof obs.loading == 'function')
        await obs.loading()
    }

    const content  = await this.fs.read(filename)
    const document = yaml.parseDocument(content, { tags: [ includeTag ] })
    const root     = new YamlFileNode(filename, document, content)

    this.files.push(root)

    const visit = async (parent: Node<YamlStoreState>, currentFile: YamlFileNode, items: any[], seq: yaml.ast.SeqBase) => {
      for (let i = 0; i < items.length; i++)
      {
        let item = items[i]
        let node = <yaml.ast.AstNode>seq.items[i]

        if (typeof item == 'string')
        {
          await parent.createChild(i, item, null, child => {
            child.syntax = new YamlChildNode(node, 'plain', currentFile)
          })
        }
        else if (typeof item == 'object')
        {
          let filename = null
          let contents = null
          let document = null

          if (typeof item.__include__ == 'string')
          {
            filename = item.__include__

            if (filename == currentFile.filename) {
              errors.push(`Cannot recursively import file ${filename}.`)
              continue
            }

            if (!filename.endsWith('.yaml') && !filename.endsWith('.yml')) {
              errors.push(`File ${filename} is not a YAML file.`)
              continue
            }

            contents = await this.fs.read(filename)

            if (contents == null) {
              errors.push(`File ${filename} does not exist.`)
              continue
            }

            document = yaml.parseDocument(contents, { tags: [ includeTag ] })

            if (!document.contents || document.contents.type != 'MAP') {
              errors.push(`File ${filename} has an invalid content.`)
              continue
            }

            node = document.contents
            item = node.toJSON()
          }

          let text = item['text']

          if (typeof text.__include__ == 'string') {
            // Text is included from other file
            filename = text.__include__
            text     = await this.fs.read(filename)

            if (text == null) {
              errors.push(`File ${filename} does not exist.`)
              continue
            }
          } else if (typeof text != 'string') {
            errors.push(`A note does not have any text.`)
            continue
          }

          const child = await parent.createChild(i, text, item, child => {
            if (document != null) {
              // Own file
              child.syntax = new YamlFileNode(filename, document, contents)

              this.files.push(child.syntax)
            } else if (filename != null) {
              // Child, but with text imported from other file
              const file = new IncludedFile(filename, text)

              child.syntax = new YamlChildNode(node, 'included', currentFile, file)
              this.files.push(file)
            } else {
              // Regular child
              child.syntax = new YamlChildNode(node, 'property', currentFile)
            }
          })

          const id = item['id']

          if (typeof id == 'string') {
            ids[id] = child
          }

          const map = <yaml.ast.Map>node

          if (item.notes)
            await visit(child, child.syntax.file, item.notes, NodeHelpers.getValue(map, k => k == 'notes') as yaml.ast.Seq)
          else if (item.items)
            await visit(child, child.syntax.file, item.items, NodeHelpers.getValue(map, k => k == 'items') as yaml.ast.Seq)
          else if (item.children)
            await visit(child, child.syntax.file, item.children, NodeHelpers.getValue(map, k => k == 'children') as yaml.ast.Seq)
        }
        else
        {
          errors.push(`Invalid YAML document.`)
          continue
        }
      }
    }

    if (!document.contents || document.contents.type != 'MAP') {
      errors.push(`Invalid YAML document.`)
      return errors
    }

    const items = NodeHelpers.getValue(document.contents, k => k == 'items' || k == 'notes')

    if (!items || items.type != 'SEQ') {
      errors.push(`Invalid YAML document.`)
      return errors
    }

    this.root.syntax = root

    await this.root.insert(null, 0)

    await visit(this.root, root, items.toJSON(), items)

    for (const observer of this.observers) {
      const obs = observer as any as StoreObserver<any>

      if (typeof obs.loaded == 'function')
        await obs.loaded()
    }

    return errors
  }


  async save() {
    clearTimeout(this.saveTimeout)

    this.saveTimeout = null

    for (const observer of this.observers) {
      const obs = observer as any as StoreObserver<any>

      if (typeof obs.saving == 'function')
        await obs.saving()
    }

    for (const file of this.files) {
      if (!file.isDirty)
        continue

      if (file.kind == 'file')
        file.contents = file.document.toString()
      else
        file.contents = file.nextContents

      await this.fs.write(file.filename, file.contents)

      file.isDirty = false
    }

    for (const observer of this.observers) {
      const obs = observer as any as StoreObserver<any>

      if (typeof obs.saved == 'function')
        await obs.saved()
    }
  }


  private scheduleSave() {
    const throttle = this.throttleMs

    if (throttle == Infinity)
      return

    if (this.saveTimeout)
      clearTimeout(this.saveTimeout)

    this.saveTimeout = setTimeout(() => {
      this.save()
    }, throttle)
  }

  private markDirty(node: Node<YamlStoreState> | IncludedFile) {
    if (node instanceof BaseNode)
      node.syntax.file.isDirty = true
    else
      node.isDirty = true

    this.scheduleSave()
  }


  inserted(node: Node<YamlStoreState>) {
    if (node.syntax || !node.parent)
      // already initialized (or root), we don't care
      return

    node.syntax = new YamlChildNode(yaml.createNode(node.dataOrText) as any, typeof node.dataOrText == 'string' ? 'plain' : 'property', node.parent.syntax.file)
    node.parent.syntax.seq.items.splice(node.index, 0, <yaml.ast.Map>node.syntax.map)

    this.markDirty(node)
  }

  removed(node: Node<YamlStoreState>, oldParent: Node<YamlStoreState>, oldIndex: number) {
    node.syntax = null
    oldParent.syntax.seq.items.splice(oldIndex, 1)

    this.markDirty(oldParent)
  }

  async propertyUpdated(node: Node<YamlStoreState>, propertyKey: string, newValue: any) {
    if (propertyKey == 'text' && node.syntax.kind == 'child') {
      if (node.syntax.textKind == 'plain') {
        // Updating text only, no need to create a new map
        node.syntax.node = yaml.createNode(newValue) as yaml.ast.ScalarNode
      } else if (node.syntax.textKind == 'included') {
        // Edited text that comes from another file, so we write to the file itself
        node.syntax.node = yaml.createNode(newValue) as yaml.ast.ScalarNode
        node.syntax.includedFile.nextContents = newValue

        this.markDirty(node.syntax.includedFile)
      } else {
        NodeHelpers.setValue(node.syntax.map, 'text', yaml.createNode(newValue) as any)
      }
    } else {
      NodeHelpers.setValue(node.syntax.map, propertyKey, yaml.createNode(newValue) as any)
    }

    this.markDirty(node)
  }

  moved(node: Node<YamlStoreState>, oldParent: Node<YamlStoreState>, oldIndex: number) {
    if (node.syntax.kind == 'file') {
      console.log('fuck', node)
    }

    node.parent.syntax.seq.items.splice(node.index, 0, <yaml.ast.Map>node.syntax.map)
    oldParent.syntax.seq.items.splice(oldIndex, 1)

    if (node.syntax.kind == 'child')
      // Update file, in case it changed from one to another
      node.syntax.file = node.parent.syntax.file

    this.markDirty(node)
  }
}
