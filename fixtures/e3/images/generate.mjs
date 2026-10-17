// Synthetic fixtures only. Regenerate explicitly with the pinned development engine.
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const pixels = Buffer.alloc(32 * 24 * 4);
for (let index = 0; index < pixels.length; index += 4) {
  pixels[index] = index % 251; pixels[index + 1] = index * 3 % 253; pixels[index + 2] = 170; pixels[index + 3] = index % 3 ? 255 : 64;
}
const source = () => sharp(pixels, { raw: { width: 32, height: 24, channels: 4 } });
await writeFile(new URL('alpha.png', import.meta.url), await source().png().toBuffer());
await writeFile(new URL('oriented.jpeg', import.meta.url), await source().flatten({ background: '#ffffff' }).jpeg().withMetadata({ orientation: 6 }).toBuffer());
await writeFile(new URL('alpha.avif', import.meta.url), await source().avif({ quality: 70, effort: 4 }).toBuffer());
const secondFrame = Buffer.from(pixels);
for (let index = 0; index < secondFrame.length; index += 4) secondFrame[index] = 255 - secondFrame[index];
await writeFile(new URL('animated.gif', import.meta.url), await sharp(Buffer.concat([pixels, secondFrame]), { raw: { width: 32, height: 48, channels: 4, pageHeight: 24 } }).gif({ delay: [100, 200], loop: 0 }).toBuffer());
await writeFile(new URL('invalid.bin', import.meta.url), 'A3 synthetic invalid image\0\n');
const fixtures = {};
for (const name of ['alpha.png', 'oriented.jpeg', 'alpha.avif', 'animated.gif', 'invalid.bin']) {
  const bytes = await readFile(new URL(name, import.meta.url));
  fixtures[name] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}
await writeFile(new URL('manifest.json', import.meta.url), JSON.stringify({ synthetic: true, engine: sharp.versions, fixtures }, null, 2) + '\n');
