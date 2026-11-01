// Test-only loader: .tsx modules of the viewer are transpiled with TypeScript (JSX → react/jsx-runtime) so that the
// renderer can be exercised without a browser (react-dom/server). .ts files keep Node's own type stripping.
import { readFile } from "node:fs/promises";
import ts from "typescript";

export async function load(url, context, nextLoad) {
  if (!url.endsWith(".tsx")) return nextLoad(url, context);
  const source = await readFile(new URL(url), "utf8");
  const output = ts.transpileModule(source, {
    fileName: new URL(url).pathname,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: true, allowImportingTsExtensions: true, rewriteRelativeImportExtensions: false },
  });
  return { format: "module", source: output.outputText, shortCircuit: true };
}

// The vendored registry (components/ui) imports without extensions or with `.js` for `.tsx` sources, as bundlers do;
// the viewer's frame imports it through ui/kit.tsx (EP-081), so the renderer tests resolve those the same way.
export async function resolve(specifier, context, nextResolve) {
  try { return await nextResolve(specifier, context); } catch (error) {
    if (!/^\.\.?\//.test(specifier) || !context.parentURL?.startsWith("file:")) throw error;
    const base = specifier.replace(/\.js$/, "");
    for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      try { return await nextResolve(base + ext, context); } catch { /* next candidate */ }
    }
    throw error;
  }
}
