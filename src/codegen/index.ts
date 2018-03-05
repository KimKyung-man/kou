import * as a from '../parser/ast';
import { wat2wasm } from '../wasm';

export function genWASM(mod: a.Module, exportName: string): Buffer {
  return wat2wasm(genWAT(mod, exportName));
}

export function genWAT(mod: a.Module, exportName: string): string {
  const ctx = new CodegenContext();
  let result = '';
  for (const thunk of codegenModule(mod, exportName, ctx)) {
    result += thunk + ' ';
  }
  return result;
}

class CodegenContext {
  private globalNameMap: Map<string, string> = new Map();
  private localNameMaps: Array<Map<string, string>> = [];
  private aliasMaps: Array<Map<string, string>> = [new Map()];

  public globalInitializers: Array<{ watName: string; expr: a.Expr<any> }> = [];

  enterScope() {
    this.localNameMaps.unshift(new Map());
    this.aliasMaps.unshift(new Map());
  }

  leaveScope() {
    this.localNameMaps.shift();
    this.aliasMaps.shift();
  }

  pushName(origName: string): string {
    const nameMap = this.localNameMaps[0] || this.globalNameMap;

    // FIXME: add a logic to convert the original name
    const name = origName;

    nameMap.set(origName, name);
    return name;
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

function* codegenModule(
  mod: a.Module,
  exportName: string,
  ctx: CodegenContext,
): Iterable<string> {
  yield '(module';

  // FIXME: imports

  for (const decl of mod.value.decls) {
    yield* codegenGlobalDecl(decl, ctx);
  }

  yield* codegenStartFunc(ctx);

  yield `(export "${exportName}" (func $${ctx.getGlobalWATName(exportName)}))`;

  yield ')';
}

function* codegenStartFunc(ctx: CodegenContext): Iterable<string> {
  if (ctx.globalInitializers.length === 0) {
    return;
  }

  yield '(func $/start';

  for (const { watName, expr } of ctx.globalInitializers) {
    yield* codegenExpr(expr, ctx);
    yield `(set_global $${watName})`;
  }

  yield ')';
  yield '(start $/start)';
}

function* codegenGlobalDecl(
  decl: a.Decl,
  ctx: CodegenContext,
): Iterable<string> {
  const expr = decl.value.expr;
  if (expr instanceof a.FuncExpr) {
    yield* codegenFunction(decl.value.name.value, decl.value.expr, ctx);
  } else if (expr instanceof a.IdentExpr && expr.type instanceof a.FuncType) {
    // function name alias
    ctx.pushAlias(decl.value.name.value, expr.value.value);
  } else {
    yield* codegenGlobalVar(decl, ctx);
  }
}

function* codegenFunction(
  origName: string,
  func: a.FuncExpr,
  ctx: CodegenContext,
): Iterable<string> {
  const name = ctx.pushName(origName);

  yield `(func $${name}`;

  ctx.enterScope();

  for (const param of func.value.params.items) {
    yield '(param';
    yield `$${ctx.pushName(param.name.value)}`;
    yield* codegenType(param.type, ctx);
    yield ')';
  }

  yield '(result';
  yield* codegenType(func.value.returnType, ctx);
  yield ')';

  yield* codegenBlock(func.value.body, false, ctx);

  ctx.leaveScope();

  yield ')';
}

function* codegenType(ty: a.Type<any>, ctx: CodegenContext): Iterable<string> {
  if (ty instanceof a.IntType) {
    yield 'i32';
  } else if (ty instanceof a.FloatType) {
    yield 'f64';
  } else if (ty instanceof a.StrType) {
    yield 'i32'; // memory offset
  } else if (ty instanceof a.BoolType) {
    yield 'i32'; // 0 or 1
  } else if (ty instanceof a.CharType) {
    yield 'i32'; // ascii
  } else if (ty instanceof a.VoidType) {
    yield '';
  }

  // FIXME: complex types
}

function* codegenBlock(
  block: a.Block,
  createWASMBlock: boolean,
  ctx: CodegenContext,
): Iterable<string> {
  for (const body of block.value.bodies) {
    if (body instanceof a.Decl) {
      yield* codegenLocalVar(body, true, ctx);
    }
  }

  for (const body of block.value.bodies) {
    if (body instanceof a.Expr) {
      // expr
      yield* codegenExpr(body, ctx);
    } else {
      // local decl
      yield* codegenLocalVar(body, false, ctx);
    }
  }

  yield '(return)';
}

function* codegenExpr(
  expr: a.Expr<any>,
  ctx: CodegenContext,
): Iterable<string> {
  if (expr instanceof a.LitExpr) {
    yield* codegenLiteral(expr.value, ctx);
  } else if (expr instanceof a.IdentExpr) {
    yield* codegenIdent(expr.value, ctx);
  } else if (expr instanceof a.CallExpr) {
    yield* codegenCallExpr(expr, ctx);
  }
  // FIXME
}

function* codegenLiteral(
  lit: a.Literal<any>,
  ctx: CodegenContext,
): Iterable<string> {
  if (lit instanceof a.IntLit) {
    yield `(i32.const ${lit.value})`;
  } else if (lit instanceof a.FloatLit) {
    yield `(f64.const ${lit.value})`;
  } else if (lit instanceof a.StrLit) {
    // FIXME: string literal
  } else if (lit instanceof a.CharLit) {
    yield `(i32.const ${lit.parsedValue.codePointAt(0)})`;
  } else if (lit instanceof a.BoolLit) {
    yield `(i32.const ${lit.parsedValue ? 1 : 0})`;
  }
}

function* codegenInitialValForType(
  lit: a.Type<any>,
  ctx: CodegenContext,
): Iterable<string> {
  if (lit instanceof a.IntType) {
    yield `(i32.const 0)`;
  } else if (lit instanceof a.FloatType) {
    yield `(f64.const 0)`;
  } else if (lit instanceof a.StrType) {
    // FIXME: string literal
  } else if (lit instanceof a.CharType) {
    yield `(i32.const 0)`;
  } else if (lit instanceof a.BoolType) {
    yield `(i32.const 0)`;
  }
  // FIXME: complex types
}

function* codegenIdent(ident: a.Ident, ctx: CodegenContext): Iterable<string> {
  let name = ctx.getLocalWATName(ident.value);
  if (name) {
    yield `(get_local $${name})`;
  } else {
    name = ctx.getGlobalWATName(ident.value);
    yield `(get_global $${name})`;
  }
}

function* codegenCallExpr(
  call: a.CallExpr,
  ctx: CodegenContext,
): Iterable<string> {
  if (!(call.value.func instanceof a.IdentExpr)) {
    // do not support
    return;
  }

  if (call.value.args instanceof a.TupleExpr) {
    for (const arg of call.value.args.value.items) {
      yield* codegenExpr(arg, ctx);
    }
  } else {
    yield* codegenExpr(call.value.args, ctx);
  }

  const funcName = ctx.getGlobalWATName(call.value.func.value.value);
  yield `(call $${funcName})`;
}

function* codegenLocalVar(
  decl: a.Decl,
  init: boolean,
  ctx: CodegenContext,
): Iterable<string> {
  const origName = decl.value.name.value;
  const expr = decl.value.expr;

  if (expr instanceof a.IdentExpr && expr.type instanceof a.FuncType) {
    if (!init) {
      ctx.pushAlias(origName, ctx.getGlobalWATName(expr.value.value)!);
    }
  } else {
    if (init) {
      const name = ctx.pushName(origName);
      yield `(local $${name}`;
      yield* codegenType(expr.type!, ctx);
      yield ')';
    } else {
      const name = ctx.getLocalWATName(origName);
      yield* codegenExpr(expr, ctx);
      yield `(set_local $${name})`;
    }
  }
}

function* codegenGlobalVar(
  decl: a.Decl,
  ctx: CodegenContext,
): Iterable<string> {
  const name = ctx.pushName(decl.value.name.value);
  yield `(global $${name}`;
  const expr = decl.value.expr;
  if (expr instanceof a.LitExpr) {
    yield* codegenType(expr.type!, ctx);
    yield* codegenLiteral(expr.value, ctx);
  } else {
    yield '(mut';
    yield* codegenType(expr.type!, ctx);
    yield ')';
    yield* codegenInitialValForType(expr.type!, ctx);
    ctx.pushInitializer(name, expr);
  }

  yield ')';
}
