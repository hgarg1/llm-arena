import ts from 'typescript';
import { GameEngine } from '../game/types';
import { loadSandboxedEngine } from '../game/sandbox';

export const BUILT_IN_GAME_KEYS = new Set([
  'iterated-negotiation',
  'chess',
  'chutes_and_ladders',
  'texas_holdem',
  'blackjack'
]);

const formatDiagnostic = (diagnostic: ts.Diagnostic) => {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (!diagnostic.file || diagnostic.start === undefined) return message;
  const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${diagnostic.file.fileName}:${line + 1}:${character + 1} ${message}`;
};

export const transpileGameEngineArtifact = (gameKey: string, codeTs: string) => {
  const result = ts.transpileModule(codeTs, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true
    },
    fileName: `${gameKey}.ts`,
    reportDiagnostics: true
  });

  const diagnostics = (result.diagnostics || [])
    .filter(diag => diag.category === ts.DiagnosticCategory.Error)
    .map(formatDiagnostic);

  return {
    ok: diagnostics.length === 0,
    codeJs: result.outputText,
    diagnostics
  };
};

export const instantiateGameEngineArtifact = (gameKey: string, codeTs: string): GameEngine => {
  const transpiled = transpileGameEngineArtifact(gameKey, codeTs);
  if (!transpiled.ok) {
    throw new Error(`Compile failed:\n${transpiled.diagnostics.join('\n')}`);
  }
  return loadSandboxedEngine(gameKey, transpiled.codeJs);
};
