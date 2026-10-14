import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.join(root, 'fixtures', 'manifest.json');
const outputDir = path.join(root, 'outputs', 'mermaid');

export default defineConfig({
  publicDir: false,
  plugins: [{
    name: 'a3-mermaid-spike-artifact-writer',
    configureServer(server) {
      server.middlewares.use('/__artifact', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST required');
          return;
        }
        try {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const { name, svg } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const expected = new Map([
            ['mermaid-c4-context', 'fixtures/mermaid/c4-context.mmd'],
            ['mermaid-class-model', 'fixtures/mermaid/class-model.mmd'],
          ]).get(name);
          if (!expected || typeof svg !== 'string' || !svg.startsWith('<svg')) throw new Error('invalid artifact payload');
          const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
          const fixture = await readFile(path.join(root, expected));
          const actualHash = createHash('sha256').update(fixture).digest('hex');
          if (manifest.files[expected]?.sha256 !== actualHash) throw new Error(`source hash mismatch for ${expected}`);
          await mkdir(outputDir, { recursive: true });
          const outputPath = path.join(outputDir, `${name}.svg`);
          await writeFile(outputPath, svg, 'utf8');
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ path: path.relative(root, outputPath).replaceAll('\\', '/'), sourceSha256: actualHash }));
        } catch (error) {
          res.statusCode = 400;
          res.end(String(error?.message ?? error));
        }
      });
    },
  }],
});
