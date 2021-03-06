import * as a from '../parser/ast';

export class CodegenContext {
  private globalNameMap: Map<string, string> = new Map();
  private localNameMaps: Array<Map<string, string>> = [];
  private aliasMaps: Array<Map<string, string>> = [new Map()];

  private scopeIDStack: Array<number> = [];
  private incrScopeID: number = 0;

  public globalInitializers: Array<{ watName: string; expr: a.Expr<any> }> = [];

  private enterScope() {
    this.localNameMaps.unshift(new Map());
    this.aliasMaps.unshift(new Map());
  }

  private leaveScope() {
    this.localNameMaps.shift();
    this.aliasMaps.shift();
  }

  enterFunction() {
    this.enterScope();
    this.resetScopeID();
  }

  leaveFunction() {
    this.leaveScope();
  }

  enterBlock() {
    this.enterScope();
    this.incrScopeID++;
    this.scopeIDStack.unshift(this.incrScopeID);
  }

  leaveBlock() {
    this.leaveScope();
    this.scopeIDStack.shift();
  }

  resetScopeID() {
    this.scopeIDStack = [];
    this.incrScopeID = 0;
  }

  private withScopeID(name: string): string {
    if (this.scopeIDStack.length === 0) {
      return name;
    } else {
      return `${name}/${this.scopeIDStack[0]}`;
    }
  }

  convertLocalName(origName: string): string {
    return this.withScopeID(origName);
  }

  pushName(origName: string): string {
    const nameMap = this.localNameMaps[0] || this.globalNameMap;
    const watName = this.convertLocalName(origName);
    nameMap.set(origName, watName);
    return watName;
  }

  pushAlias(fromName: string, toName: string) {
    this.aliasMaps[0]!.set(fromName, toName);
  }

  pushInitializer(watName: string, expr: a.Expr<any>) {
    // name here is a WAT name
    this.globalInitializers.push({ watName, expr });
  }

  getLocalWATName(origName: string): string | null {
    for (const map of this.localNameMaps) {
      const name = map.get(origName);
      if (name) {
        return name;
      }
    }

    return null;
  }

  getGlobalWATName(origName: string): string | null {
    let aliasedName = null;
    for (const map of this.aliasMaps) {
      aliasedName = map.get(origName);
      if (aliasedName) {
        break;
      }
    }
    return this.globalNameMap.get(aliasedName || origName) || null;
  }
}
