import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { API, NodeBuilderFlags, SignatureKind, SymbolFlags, type Checker, type Project, type Signature, type Symbol as TsSymbol, type Type } from "typescript/unstable/sync";
import { SyntaxKind, isClassDeclaration, isEnumDeclaration, isInterfaceDeclaration, isParameterDeclaration, isTypeAliasDeclaration, isVariableDeclaration, type Node } from "typescript/unstable/ast";
import { libraries } from "../src/data/libraries";
import { REPO_DIR, SITE_DIR } from "./config";

export interface ApiEntry {
  library: string;
  name: string;
  file: string;
  subpath: string;
  runtime: string;
}

export interface ApiSource { file: string; line: number }
export interface ApiParameter {
  name: string;
  type: string;
  optional: boolean;
  defaultValue?: string;
  description: string;
  properties: ApiMember[];
}
export interface ApiSignature {
  text: string;
  parameters: ApiParameter[];
  returns: string;
  returnDescription: string;
}
export interface ApiMember {
  name: string;
  description: string;
  type: string;
  optional: boolean;
  readonly: boolean;
  static: boolean;
  signatures: ApiSignature[];
  source: ApiSource;
}
export interface ApiSymbol {
  name: string;
  declaredName: string;
  kind: "function" | "class" | "interface" | "type" | "constant" | "enum";
  description: string;
  declaration: string;
  signatures: ApiSignature[];
  members: ApiMember[];
  returnedMembers: ApiMember[];
  throws: string[];
  deprecated?: string;
  source: ApiSource;
}
export interface ApiModule extends ApiEntry { symbols: ApiSymbol[] }

/** Resolve public source conditions without depending on generated dist files. */
export function sourceExport(target: unknown): string | undefined {
  if (typeof target === "string") return target;
  if (target && typeof target === "object" && "@toip-tools/source" in target) {
    return sourceExport((target as Record<string, unknown>)["@toip-tools/source"]);
  }
  return undefined;
}

function declarationOf(symbol: TsSymbol): Node | undefined {
  return (symbol.valueDeclaration ?? symbol.declarations[0])?.resolve();
}

function sourceOf(node: Node): ApiSource {
  const file = node.getSourceFile();
  return { file: relative(REPO_DIR, file.fileName).replaceAll("\\", "/"), line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1 };
}

function owns(node: Node): boolean {
  const file = sourceOf(node).file;
  return !file.startsWith("..") && !file.includes("node_modules/");
}

function modifiers(node: Node): readonly Node[] {
  return "modifiers" in node ? (node as Node & { modifiers?: readonly Node[] }).modifiers ?? [] : [];
}

function isPublic(node: Node): boolean {
  return !modifiers(node).some(m => m.kind === SyntaxKind.PrivateKeyword || m.kind === SyntaxKind.ProtectedKeyword)
    && !("name" in node && (node as Node & { name?: Node }).name?.kind === SyntaxKind.PrivateIdentifier);
}

function isOptional(symbol: TsSymbol, node: Node): boolean {
  return !!(symbol.flags & SymbolFlags.Optional) || (isParameterDeclaration(node) && !!(node.questionToken || node.initializer));
}

function typeText(checker: Checker, type: Type | undefined, node: Node): string {
  if (!type || type.isErrorType()) throw new Error(`Cannot resolve SDK type at ${sourceOf(node).file}:${sourceOf(node).line}`);
  return checker.typeToString(type, node, NodeBuilderFlags.NoTruncation);
}

function tags(symbol: TsSymbol, checker: Checker, name: string): string[] {
  return symbol.getJsDocTags(checker).filter(tag => tag.name === name).map(tag => tag.text ?? "");
}

function signatureInfo(signature: Signature, project: Project, enclosing: Node, construct = false): ApiSignature {
  const checker = project.checker;
  const declaration = signature.declaration?.resolve() ?? enclosing;
  const signatureNode = checker.signatureToSignatureDeclaration(signature, construct ? SyntaxKind.ConstructSignature : SyntaxKind.CallSignature, enclosing, NodeBuilderFlags.NoTruncation);
  if (!signatureNode) throw new Error(`Cannot print SDK signature at ${sourceOf(enclosing).file}`);
  const returnType = checker.getReturnTypeOfSignature(signature);
  const parameters = signature.getParameters().map(parameter => {
    const node = declarationOf(parameter) ?? declaration;
    const type = checker.getTypeOfSymbol(parameter);
    const name = isParameterDeclaration(node) ? node.name.getText() : parameter.name;
    const describeOptions = /^(opts?|options|config|input|policy|requirements)$/i.test(name);
    return {
      name,
      type: typeText(checker, type, node),
      optional: isOptional(parameter, node),
      defaultValue: isParameterDeclaration(node) ? node.initializer?.getText() : undefined,
      description: parameter.getDocumentationComment(checker),
      properties: describeOptions && type ? membersOf(type, project, false, false) : [],
    };
  });
  const declarationName = (declaration as Node & { name?: Node }).name;
  const symbol = declarationName ? checker.getSymbolAtLocation(declarationName) : undefined;
  return {
    text: project.emitter.printNode(signatureNode),
    parameters,
    returns: typeText(checker, returnType, enclosing),
    returnDescription: symbol ? tags(symbol, checker, "returns").concat(tags(symbol, checker, "return")).join(" ") : "",
  };
}

function membersOf(type: Type, project: Project, isStatic = false, withSignatures = true): ApiMember[] {
  const checker = project.checker;
  return checker.getPropertiesOfType(type).flatMap(symbol => {
    if (symbol.name === "prototype") return [];
    const node = declarationOf(symbol);
    if (!node || !owns(node) || !isPublic(node)) return [];
    const memberType = checker.getTypeOfSymbol(symbol);
    if (!memberType || memberType.isErrorType()) return [];
    const calls = withSignatures ? checker.getSignaturesOfType(memberType, SignatureKind.Call) : [];
    return [{
      name: symbol.name,
      description: symbol.getDocumentationComment(checker),
      type: typeText(checker, memberType, node),
      optional: isOptional(symbol, node),
      readonly: modifiers(node).some(m => m.kind === SyntaxKind.ReadonlyKeyword),
      static: isStatic,
      signatures: calls.map(s => signatureInfo(s, project, node)),
      source: sourceOf(node),
    }];
  });
}

function symbolInfo(exported: TsSymbol, project: Project): ApiSymbol {
  const checker = project.checker;
  const symbol = exported.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
  const node = declarationOf(symbol);
  if (!node) throw new Error(`No source declaration for exported SDK symbol ${exported.name}`);
  const valueType = checker.getTypeOfSymbol(symbol);
  const calls = valueType ? checker.getSignaturesOfType(valueType, SignatureKind.Call) : [];
  const isClass = isClassDeclaration(node);
  const kind: ApiSymbol["kind"] = isClass ? "class" : isInterfaceDeclaration(node) ? "interface" : isTypeAliasDeclaration(node) ? "type" : isEnumDeclaration(node) ? "enum" : calls.length ? "function" : "constant";
  const signatures = isClass && valueType
    ? checker.getSignaturesOfType(valueType, SignatureKind.Construct).filter(s => {
      const declaration = s.declaration?.resolve();
      return !declaration || isPublic(declaration);
    }).map(s => signatureInfo(s, project, node, true))
    : calls.map(s => signatureInfo(s, project, node));
  let declaration: string;
  if (kind === "class") declaration = `class ${exported.name}`;
  else if (["interface", "type", "enum"].includes(kind)) {
    declaration = node.getText().replace(/^(?:export\s+)?(?:declare\s+)?(interface|type|enum)\s+\w+/, `$1 ${exported.name}`);
  } else if (kind === "function") declaration = signatures.map(s => `${exported.name}${s.text}`).join("\n");
  else declaration = `const ${exported.name}: ${typeText(checker, valueType, node)};`;
  const declaredType = ["class", "interface", "type"].includes(kind) ? checker.getDeclaredTypeOfSymbol(symbol) : undefined;
  const objectMembers = declaredType?.isObjectType() ? membersOf(declaredType, project) : [];
  const returnType = calls[0] ? checker.getReturnTypeOfSignature(calls[0]) : undefined;
  const returnedMembers = returnType?.isObjectType() && !returnType.isClassOrInterface() ? membersOf(returnType, project) : [];
  return {
    name: exported.name,
    declaredName: symbol.name,
    kind,
    description: symbol.getDocumentationComment(checker),
    declaration,
    signatures,
    members: [...objectMembers, ...(isClass && valueType ? membersOf(valueType, project, true) : [])],
    returnedMembers,
    throws: tags(symbol, checker, "throws").concat(tags(symbol, checker, "exception")),
    deprecated: tags(symbol, checker, "deprecated")[0],
    source: sourceOf(node),
  };
}

export function readSdkModules(entries: ApiEntry[], configFile = join(SITE_DIR, "tsconfig.sdk.json")): ApiModule[] {
  const api = new API({ cwd: REPO_DIR });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [configFile] });
    const project = snapshot.getProject(configFile);
    if (!project) throw new Error(`Cannot load SDK documentation project ${configFile}`);
    return entries.map(entry => {
      const abs = isAbsolute(entry.file) ? entry.file : join(REPO_DIR, entry.file);
      const source = project.program.getSourceFile(abs);
      if (!source) throw new Error(`SDK entry point is missing from the compiler project: ${entry.file}`);
      const module = project.checker.getSymbolAtLocation(source);
      if (!module) throw new Error(`SDK entry point has no exports: ${entry.file}`);
      const symbols = project.checker.getExportsOfModule(module).map(s => symbolInfo(s, project)).sort((a, b) => a.name.localeCompare(b.name));
      return { ...entry, file: relative(REPO_DIR, abs).replaceAll("\\", "/"), symbols };
    });
  } finally {
    api.close();
  }
}

export function sdkEntryPoints(): ApiEntry[] {
  return libraries.flatMap(library => {
    const pkg = JSON.parse(readFileSync(join(REPO_DIR, library.dir, "package.json"), "utf8")) as { name: string; exports: Record<string, unknown> };
    return Object.entries(pkg.exports).flatMap(([subpath, target]) => {
      const file = sourceExport(target);
      return file && /\.tsx?$/.test(file) ? [{ subpath, file }] : [];
    }).map(({subpath, file}) => {
      if (typeof file !== "string" || !existsSync(join(REPO_DIR, library.dir, file))) throw new Error(`Unsupported SDK entry ${pkg.name}${subpath}: ${JSON.stringify(file)}`);
      const nodeOnly = library.slug === "relay" || (library.slug === "eventlog" && subpath === "./node") || (library.slug === "mesh-transport" && ["./gwmp", "./detect", "./node"].includes(subpath));
      const browserOnly = library.slug === "web-vault" || (library.slug === "anon-membership" && subpath === "./worker");
      return { library: library.slug, name: pkg.name + (subpath === "." ? "" : subpath.slice(1)), subpath, file: join(library.dir, file), runtime: nodeOnly ? "Node only" : browserOnly ? "Browser" : "Browser and Node" };
    });
  });
}
