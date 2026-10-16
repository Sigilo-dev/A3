import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { contentNodeDefinition } from '@a3/domain/content-nodes';
import { hasPlantUmlSourceAuthority, plantUmlSourceProperties, PLANTUML_RENDERER_VERSION, supportsPlantUmlSourceRenderer } from '@a3/domain/plantuml-source';
import { PLANTUML_ARTIFACT_FILE, PLANTUML_ARTIFACT_SHA256, PLANTUML_ENGINE_VERSION, PlantUmlRenderer, resolveJavaRuntime } from '../src/main/plantuml-renderer.ts';

const desktopDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(desktopDirectory, '..', '..');
const fixtureRoot = join(repositoryRoot, 'fixtures', 'e3', 'plantuml');
const artifact = join(desktopDirectory, 'resources', 'plantuml', PLANTUML_ARTIFACT_FILE);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function testDirectory() { return mkdtemp(join(tmpdir(), 'a3-plantuml-test-')); }
function input(source, root, workingDirectory = root) {
  return { source, sourceHash: hash(Buffer.from(source, 'utf8')), workingDirectory, includeRoots: [root] };
}
function renderer(directory, options = {}) {
  return new PlantUmlRenderer({ artifactPath: artifact, installDirectory: join(directory, 'installed'), ...options });
}

test('E3-E1 registra la fuente como autoridad y fija el catálogo/versionado del renderer', () => {
  assert.equal(contentNodeDefinition('plantuml').extension, '.puml');
  assert.equal(PLANTUML_RENDERER_VERSION, PLANTUML_ENGINE_VERSION);
  assert.equal(hasPlantUmlSourceAuthority(plantUmlSourceProperties()), true);
  assert.equal(supportsPlantUmlSourceRenderer('a3.diagram.plantuml', '1.0.0', plantUmlSourceProperties()), true);
  assert.equal(supportsPlantUmlSourceRenderer('a3.diagram.plantuml', '2.0.0', plantUmlSourceProperties()), false);
  assert.equal(supportsPlantUmlSourceRenderer('a3.diagram.plantuml', '1.0.0', { ...plantUmlSourceProperties(), 'a3.diagram.authority': 'a3-model' }), false);
});

test('E3-E1 instala solo el artefacto fijado, valida SHA-256 y renderiza el fixture sin mutar la fuente', async (t) => {
  const directory = await testDirectory(); t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'project'); await mkdir(root);
  const sourcePath = join(fixtureRoot, 'class-model.puml');
  const originalBytes = await readFile(sourcePath), source = originalBytes.toString('utf8');
  assert.equal(hash(await readFile(artifact)), PLANTUML_ARTIFACT_SHA256);
  const java = await resolveJavaRuntime(); assert.ok(java && java.major >= 21);
  const license = spawnSync(java.executable, ['-jar', artifact, '-license'], { encoding: 'utf8', timeout: 5_000, windowsHide: true });
  assert.equal(license.status, 0);
  assert.match(license.stdout, /MIT License/);
  const result = await renderer(directory).render(input(source, root));
  assert.equal(result.state, 'rendered');
  assert.equal(result.rendererVersion, PLANTUML_ENGINE_VERSION);
  assert.equal(result.sourceHash, hash(originalBytes));
  assert.match(result.svg, /<svg\b/i);
  assert.doesNotMatch(result.svg, /Welcome to PlantUML!/);
  assert.match(result.javaVersion, /^21\.|^(?:2[2-9]|[3-9]\d)\./);
  assert.equal(hash(await readFile(sourcePath)), hash(originalBytes));
});

test('E3-E1 informa motor faltante sin intentar ejecutar una fuente', async (t) => {
  const directory = await testDirectory(); t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'project'); await mkdir(root);
  const instance = new PlantUmlRenderer({ artifactPath: join(directory, 'missing.jar'), installDirectory: join(directory, 'installed'), runProcess: async () => { throw new Error('must not launch'); } });
  const result = await instance.render(input('@startuml\nAlice -> Bob\n@enduml', root));
  assert.equal(result.state, 'unavailable');
  assert.match(result.message, /artefacto oficial PlantUML MIT/i);
});

test('E3-E1 muestra runtime Java ausente y no inicia el proceso', async (t) => {
  const directory = await testDirectory(); t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'project'); await mkdir(root);
  let launched = false;
  const result = await renderer(directory, { resolveJava: async () => undefined, runProcess: async () => { launched = true; throw new Error('must not launch'); } })
    .render(input('@startuml\nAlice -> Bob\n@enduml', root));
  assert.equal(result.state, 'unavailable');
  assert.match(result.message, /Java 21 o posterior/i);
  assert.equal(launched, false);
});

test('E3-E1 permite la biblioteca estándar empaquetada en el JAR bajo ALLOWLIST', async (t) => {
  const directory = await testDirectory(); t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'project'); await mkdir(root);
  const source = await readFile(join(fixtureRoot, 'stdlib-c4.puml'), 'utf8');
  const result = await renderer(directory).render(input(source, root));
  assert.equal(result.state, 'rendered');
  assert.match(result.svg, /User/);
  assert.match(result.svg, /Electron/);
});

test('E3-E1 denies included source outside authorized roots', async (t) => {
  const directory = await testDirectory(); t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'project'), sub = join(project, 'diagrams'), outside = join(directory, 'outside');
  await mkdir(sub, { recursive: true }); await mkdir(outside);
  await writeFile(join(outside, 'secret.puml'), 'class Secret\n');
  const source = await readFile(join(fixtureRoot, 'include-outside.puml'), 'utf8');
  let launched = false;
  const result = await renderer(directory, { runProcess: async () => { launched = true; throw new Error('must not launch'); } }).render(input(source, project, sub));
  assert.equal(result.state, 'invalid');
  assert.equal(result.line, 2);
  assert.equal(launched, false);
  assert.doesNotMatch(result.message, /secret\.puml|outside/i);
});

test('E3-E1 ALLOWLIST blocks URL includes before they reach the network', async (t) => {
  const directory = await testDirectory(); t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'project'); await mkdir(root);
  let requests = 0;
  const server = createServer((_request, response) => { requests += 1; response.end('@startuml\nclass RemoteSecret\n@enduml'); });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  t.after(() => new Promise((resolvePromise) => server.close(() => resolvePromise())));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const source = `@startuml\n!includeurl http://127.0.0.1:${address.port}/diagram.puml\nAlice -> Bob\n@enduml`;
  let launched = false;
  const result = await renderer(directory, { runProcess: async () => { launched = true; throw new Error('must not launch'); } }).render(input(source, root));
  assert.equal(result.state, 'invalid');
  assert.equal(launched, false);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 75));
  assert.equal(requests, 0);
});

test('E3-E1 renders local include inside the project and rejects syntax errors without changing either file', async (t) => {
  const directory = await testDirectory(); t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, 'project'); await mkdir(join(project, 'diagrams'), { recursive: true });
  await cp(join(fixtureRoot, 'includes'), join(project, 'diagrams', 'includes'), { recursive: true });
  const localSource = await readFile(join(fixtureRoot, 'include-local.puml'), 'utf8');
  const localPath = join(project, 'diagrams', 'include-local.puml'); await writeFile(localPath, localSource);
  const rendered = await renderer(directory).render(input(localSource, project, dirname(localPath)));
  assert.equal(rendered.state, 'rendered');
  assert.match(rendered.svg, /SharedConcept/);
  assert.match(rendered.svg, /NestedIncludeProof/);
  assert.equal((await readFile(localPath, 'utf8')), localSource);

  const invalidSource = await readFile(join(fixtureRoot, 'invalid.puml'), 'utf8');
  const invalidPath = join(project, 'diagrams', 'invalid.puml'); await writeFile(invalidPath, invalidSource);
  const invalid = await renderer(directory).render(input(invalidSource, project, dirname(invalidPath)));
  assert.equal(invalid.state, 'invalid');
  assert.ok(invalid.line === undefined || invalid.line > 0);
  assert.equal(await readFile(invalidPath, 'utf8'), invalidSource);
});

test('E3-E1 enforces timeout, memory, CPU, size and ALLOWLIST settings on the child process', async (t) => {
  const directory = await testDirectory(); t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'project'); await mkdir(root);
  let launch;
  const result = await renderer(directory, {
    timeoutMs: 50,
    resolveJava: async () => ({ executable: 'java.exe', major: 21, version: '21.0.10' }),
    runProcess: async (value) => { launch = value; return { code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: true, tooLarge: false }; }
  }).render(input('@startuml\nAlice -> Bob\n@enduml', root));
  assert.equal(result.state, 'timeout');
  assert.equal(launch.timeoutMs, 50);
  assert.ok(launch.args.includes('-Xmx256m'));
  assert.ok(launch.args.includes('-XX:ActiveProcessorCount=2'));
  assert.ok(launch.args.includes('-DPLANTUML_SECURITY_PROFILE=ALLOWLIST'));
  assert.equal(launch.args.some((argument) => argument.startsWith('-Dplantuml.allowlist.path=')), false);
  assert.notEqual(launch.cwd, root);
  assert.ok(launch.args.some((argument) => argument.includes('PLANTUML_LIMIT_SIZE=4096')));
  assert.match(launch.stdin, /Alice -> Bob/);
  assert.equal(launch.env.JAVA_TOOL_OPTIONS, undefined);
});

test('E3-E1 rejects excessive local includes before starting Java', async (t) => {
  const directory = await testDirectory(); t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'project'); await mkdir(root);
  for (let index = 0; index < 33; index += 1) await writeFile(join(root, `include-${index}.puml`), `class Included${index}\n`);
  const source = `@startuml\n${Array.from({ length: 33 }, (_, index) => `!include include-${index}.puml`).join('\n')}\n@enduml`;
  let launched = false;
  const result = await renderer(directory, { runProcess: async () => { launched = true; throw new Error('must not launch'); } }).render(input(source, root));
  assert.equal(result.state, 'invalid');
  assert.match(result.message, /límite de 32 includes/);
  assert.equal(launched, false);
});

test('E3-E1 preserves literal include and include_many behavior without reopening project files in Java', async (t) => {
  const directory = await testDirectory(); t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'project'); await mkdir(root);
  await writeFile(join(root, 'shared.puml'), 'class IncludeExpansionProof\n');
  const launch = async (source) => {
    let childInput = '';
    const result = await renderer(directory, {
      resolveJava: async () => ({ executable: 'java.exe', major: 21, version: '21.0.10' }),
      runProcess: async (value) => { childInput = value.stdin; return { code: 0, stdout: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), stderr: Buffer.alloc(0), timedOut: false, tooLarge: false }; }
    }).render(input(source, root));
    assert.equal(result.state, 'rendered');
    return childInput;
  };
  const includeOnce = await launch('@startuml\n!include shared.puml\n!include shared.puml\n@enduml');
  assert.equal(includeOnce.match(/IncludeExpansionProof/g)?.length, 1);
  const includeMany = await launch('@startuml\n!include_many shared.puml\n!include_many shared.puml\n@enduml');
  assert.equal(includeMany.match(/IncludeExpansionProof/g)?.length, 2);
});

test('E3-E1 rejects runtime file loaders in source before Java can process them', async (t) => {
  const directory = await testDirectory(); t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'project'); await mkdir(root);
  let launched = false;
  const source = ['@startuml', '!function $read()', '!return %load_json("secret.json")', '!endfunction', 'Alice -> Bob', '@enduml'].join('\n');
  const result = await renderer(directory, { runProcess: async () => { launched = true; throw new Error('must not launch'); } }).render(input(source, root));
  assert.equal(result.state, 'invalid');
  assert.match(result.message, /archivos\/URLs están deshabilitados/);
  assert.equal(launched, false);
});
