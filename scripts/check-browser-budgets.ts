// Audit launch ownership without running historical proofs or their game import graphs.
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript-api"

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git", ".lab-output"].includes(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* files(path)
    else if (/\.(?:ts|mjs|js)$/.test(path)) yield path
  }
}

let count = 0
const failures: string[] = []
for (const file of [...files("scripts"), ...files("games")]) {
  if (file === "scripts/browser-budget.ts" || file === "scripts/check-browser-budgets.ts") continue
  const source = readFileSync(file, "utf8")
  if (!/chromium\.launch|launchPersistentContext/.test(source)) continue
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const errors = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).diagnostics ?? []
  assert.equal(errors.length, 0, `${file}: ${errors.map(e => ts.flattenDiagnosticMessageText(e.messageText, "\n")).join("\n")}`)
  function visit(node: ts.Node) {
    if (ts.isAwaitExpression(node) && node.expression.getText(parsed).startsWith("budget.exit(")) {
      let owner = node.parent
      while (owner && !ts.isFunctionLike(owner)) owner = owner.parent
      if (owner && !ts.getModifiers(owner as ts.FunctionDeclaration)?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) failures.push(`${file}: budget.exit in a synchronous callback`)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  assert(source.includes("browser-budget"), `${file}: missing budget import`)
  assert(source.includes("const { chromium } = budget"), `${file}: launch must use budget.chromium`)
  assert(source.includes("await using budget = browserBudget()") || file === "games/carrier/scripts/video/core.ts", `${file}: missing cleanup scope`)
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    if (statement.moduleSpecifier.text !== "playwright-core") continue
    const bindings = statement.importClause?.namedBindings
    assert(!bindings || !ts.isNamedImports(bindings) || !bindings.elements.some(e => e.name.text === "chromium"), `${file}: raw Chromium import`)
  }
  count++
}
assert.deepEqual(failures, [], failures.join("\n"))
console.log(`${count} Chromium launcher files have budget ownership and parse successfully`)
