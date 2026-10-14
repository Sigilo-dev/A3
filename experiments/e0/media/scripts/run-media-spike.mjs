import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workRoot = path.join(root, '.work');
await mkdir(workRoot, { recursive: true });
const work = await mkdtemp(path.join(workRoot, 'run-'));
const outputs = path.join(work, 'out');
await mkdir(outputs);

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const duration = async (operation) => {
  const start = performance.now();
  const result = await operation();
  return { result, elapsedMs: Number((performance.now() - start).toFixed(2)) };
};
const exec = (command, args, { allowFailure = false } = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  const response = { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  if (!allowFailure && response.code !== 0) {
    throw new Error(`${path.basename(command)} exited ${response.code}: ${response.stderr.slice(-1200)}`);
  }
  return response;
};
const toolPath = (name) => execFileSync('where.exe', [name], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
const ffmpegPath = process.env.A3_FFMPEG_PATH || toolPath('ffmpeg');
const ffprobePath = process.env.A3_FFPROBE_PATH || toolPath('ffprobe');
const binaryHash = async (file) => hash(await readFile(file));
const probe = (file) => {
  const result = exec(ffprobePath, [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file,
  ]);
  return JSON.parse(result.stdout);
};
const imageMeta = async (file) => {
  const meta = await sharp(file).metadata();
  return {
    format: meta.format,
    width: meta.width,
    height: meta.height,
    space: meta.space,
    channels: meta.channels,
    hasAlpha: meta.hasAlpha,
    pages: meta.pages,
    compression: meta.compression,
  };
};

const generatedSources = [];
const rememberSource = async (file, label) => {
  generatedSources.push({ file, label, sha256: await binaryHash(file) });
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

{
  const imageWidth = 32;
  const imageHeight = 24;
  const pixels = Buffer.alloc(imageWidth * imageHeight * 4);
  for (let y = 0; y < imageHeight; y += 1) {
    for (let x = 0; x < imageWidth; x += 1) {
      const offset = (y * imageWidth + x) * 4;
      pixels[offset] = (x * 17) % 256;
      pixels[offset + 1] = (y * 29) % 256;
      pixels[offset + 2] = ((x + y) * 13) % 256;
      pixels[offset + 3] = x === 0 ? 0 : x === 1 ? 128 : 255;
    }
  }
  const raw = { raw: { width: imageWidth, height: imageHeight, channels: 4 } };
  const imageSources = {
    'source-alpha.png': () => sharp(pixels, raw).png().toFile(path.join(work, 'source-alpha.png')),
    'source.jpg': () => sharp(pixels, raw).flatten({ background: '#f4f4f4' }).jpeg({ quality: 82 }).toFile(path.join(work, 'source.jpg')),
    'source.avif': () => sharp(pixels, raw).avif({ quality: 45 }).toFile(path.join(work, 'source.avif')),
  };
  for (const create of Object.values(imageSources)) await create();

  const exifSource = path.join(work, 'source-with-exif.jpg');
  await sharp(pixels, raw).flatten({ background: '#f4f4f4' })
    .withExif({ IFD0: { ImageDescription: 'A3 synthetic E0-D3 fixture' } })
    .jpeg({ quality: 82 }).toFile(exifSource);
  const exifSourceMetadata = await sharp(exifSource).metadata();
  assert(exifSourceMetadata.exif?.length > 0, 'Synthetic EXIF metadata was not created');
  await rememberSource(exifSource, 'source-with-exif.jpg');
  const strippedExifFile = path.join(outputs, 'metadata-stripped.jpg');
  await sharp(exifSource).jpeg({ quality: 82 }).toFile(strippedExifFile);
  const strippedExifMetadata = await sharp(strippedExifFile).metadata();
  const keptExifFile = path.join(outputs, 'metadata-kept.jpg');
  await sharp(exifSource).keepExif().jpeg({ quality: 82 }).toFile(keptExifFile);
  const keptExifMetadata = await sharp(keptExifFile).metadata();
  assert(!strippedExifMetadata.exif, 'Sharp default unexpectedly retained EXIF');
  assert(keptExifMetadata.exif?.length > 0, 'Sharp keepExif did not preserve EXIF');

  const ffmpegVersion = exec(ffmpegPath, ['-version']).stdout;
  const ffprobeVersion = exec(ffprobePath, ['-version']).stdout;
  const ffmpegBuildconf = exec(ffmpegPath, ['-buildconf']).stdout;
  const ffmpegLicense = exec(ffmpegPath, ['-L']).stdout;
  const encoders = exec(ffmpegPath, ['-hide_banner', '-encoders']).stdout
    + exec(ffmpegPath, ['-hide_banner', '-encoders']).stderr;
  const encoderNames = ['ffv1', 'libx264', 'aac', 'libmp3lame', 'flac'];
  const encoderAvailability = Object.fromEntries(encoderNames.map((name) => [
    name,
    new RegExp(`\\b${name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`).test(encoders),
  ]));

  const imageSourcesInfo = {};
  for (const name of Object.keys(imageSources)) {
    const file = path.join(work, name);
    const meta = await imageMeta(file);
    imageSourcesInfo[name] = { metadata: meta, bytes: (await stat(file)).size, sha256: await binaryHash(file) };
    await rememberSource(file, name);
    assert(meta.width === imageWidth && meta.height === imageHeight, `Unexpected dimensions for ${name}`);
  }
  assert(imageSourcesInfo['source-alpha.png'].metadata.hasAlpha === true, 'Synthetic PNG lost alpha');

  const gifSource = path.join(work, 'source.gif');
  exec(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=12x12:rate=2:duration=1',
    '-loop', '0', '-y', gifSource,
  ]);
  const gifMetadata = await imageMeta(gifSource);
  imageSourcesInfo['source.gif'] = { metadata: gifMetadata, bytes: (await stat(gifSource)).size, sha256: await binaryHash(gifSource) };
  await rememberSource(gifSource, 'source.gif');
  assert(gifMetadata.width === 12 && gifMetadata.height === 12, 'Sharp could not decode the synthetic GIF');

  const imageOutputs = {};
  for (const [format, configure] of Object.entries({
    png: (pipeline) => pipeline.png(),
    jpeg: (pipeline) => pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: 82 }),
    webp: (pipeline) => pipeline.webp({ quality: 75 }),
    avif: (pipeline) => pipeline.avif({ quality: 45 }),
    tiff: (pipeline) => pipeline.tiff({ compression: 'lzw' }),
  })) {
    const destination = path.join(outputs, `from-alpha.${format === 'jpeg' ? 'jpg' : format}`);
    const measured = await duration(() => configure(sharp(path.join(work, 'source-alpha.png'))).toFile(destination));
    const meta = await imageMeta(destination);
    imageOutputs[format] = { bytes: (await stat(destination)).size, elapsedMs: measured.elapsedMs, metadata: meta };
    assert(meta.width === imageWidth && meta.height === imageHeight, `Bad ${format} output dimensions`);
  }
  assert(imageOutputs.png.metadata.hasAlpha === true, 'PNG conversion did not retain alpha');
  assert(imageOutputs.jpeg.metadata.hasAlpha === false, 'JPEG conversion should flatten alpha');

  const thumbPath = path.join(outputs, 'thumbnail.webp');
  const thumbRun = await duration(() => sharp(path.join(work, 'source-alpha.png'))
    .resize({ width: 16, height: 12, fit: 'inside' }).webp({ quality: 72 }).toFile(thumbPath));
  const thumbMeta = await imageMeta(thumbPath);
  assert(thumbMeta.width === 16 && thumbMeta.height === 12, 'Thumbnail dimensions mismatch');

  let gifEncode;
  try {
    const gifOutput = path.join(outputs, 'from-alpha.gif');
    const measured = await duration(() => sharp(path.join(work, 'source-alpha.png')).gif().toFile(gifOutput));
    gifEncode = { supported: true, bytes: (await stat(gifOutput)).size, elapsedMs: measured.elapsedMs, metadata: await imageMeta(gifOutput) };
  } catch (error) {
    gifEncode = { supported: false, diagnostic: String(error.message).slice(0, 400) };
  }

  const unsupportedImageFile = path.join(work, 'unsupported-image.bin');
  await writeFile(unsupportedImageFile, Buffer.from('A3 synthetic unsupported image bytes\n', 'utf8'));
  let unsupportedImage;
  try {
    await sharp(unsupportedImageFile).metadata();
    unsupportedImage = { rejected: false };
  } catch (error) {
    unsupportedImage = { rejected: true, diagnostic: String(error.message).slice(0, 400) };
  }
  assert(unsupportedImage.rejected, 'Unsupported image input was accepted');

  const audioSource = path.join(work, 'synthetic.wav');
  exec(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=2',
    '-c:a', 'pcm_s16le', '-y', audioSource,
  ]);
  const videoSource = path.join(work, 'synthetic.mkv');
  exec(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=44100:duration=2',
    '-shortest', '-c:v', 'ffv1', '-level', '3', '-c:a', 'pcm_s16le', '-y', videoSource,
  ]);
  await rememberSource(audioSource, 'synthetic.wav');
  await rememberSource(videoSource, 'synthetic.mkv');
  const sourceAudioProbe = probe(audioSource);
  const sourceVideoProbe = probe(videoSource);
  assert(sourceAudioProbe.streams.some((stream) => stream.codec_name === 'pcm_s16le'), 'Synthetic WAV probe mismatch');
  assert(sourceVideoProbe.streams.some((stream) => stream.codec_name === 'ffv1'), 'Synthetic MKV video probe mismatch');

  const mediaProfiles = [
    { name: 'mp4-h264-aac', file: 'sample.mp4', args: ['-map', '0:v:0', '-map', '0:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k'] , expected: { video: 'h264', audio: 'aac' } },
    { name: 'mov-h264-aac', file: 'sample.mov', args: ['-map', '0:v:0', '-map', '0:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k'], expected: { video: 'h264', audio: 'aac' } },
    { name: 'mkv-h264-flac', file: 'sample.mkv', args: ['-map', '0:v:0', '-map', '0:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'flac'], expected: { video: 'h264', audio: 'flac' } },
    { name: 'mp3-libmp3lame', file: 'sample.mp3', source: audioSource, args: ['-vn', '-c:a', 'libmp3lame', '-q:a', '5'], expected: { audio: 'mp3' } },
    { name: 'flac-native', file: 'sample.flac', source: audioSource, args: ['-vn', '-c:a', 'flac', '-compression_level', '5'], expected: { audio: 'flac' } },
  ];
  for (const profile of mediaProfiles) {
    for (const option of ['-c:v', '-c:a']) {
      const index = profile.args.indexOf(option);
      if (index >= 0) assert(encoderAvailability[profile.args[index + 1]], `Required encoder missing for ${profile.name}: ${profile.args[index + 1]}`);
    }
  }

  const mediaResults = {};
  const sourceHashesBefore = new Map(generatedSources.map((source) => [source.file, source.sha256]));
  for (const profile of mediaProfiles) {
    const output = path.join(outputs, profile.file);
    const source = profile.source || videoSource;
    const start = performance.now();
    exec(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', source, ...profile.args, '-y', output]);
    const elapsedMs = Number((performance.now() - start).toFixed(2));
    const result = probe(output);
    exec(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', output, '-f', 'null', '-']);
    const streams = result.streams.map(({ codec_type, codec_name, profile: codecProfile, width, height, sample_rate, channels }) => ({ codec_type, codec_name, profile: codecProfile, width, height, sample_rate, channels }));
    for (const [kind, expectedCodec] of Object.entries(profile.expected)) {
      assert(result.streams.some((stream) => stream.codec_type === kind && stream.codec_name === expectedCodec), `${profile.name} missing ${kind}/${expectedCodec}`);
    }
    mediaResults[profile.name] = {
      output: profile.file,
      bytes: (await stat(output)).size,
      elapsedMs,
      formatName: result.format.format_name,
      majorBrand: result.format.tags?.major_brand,
      durationSeconds: result.format.duration,
      streams,
      decodedToNull: true,
    };
  }

  const invalidMedia = path.join(work, 'unsupported-media.bin');
  await writeFile(invalidMedia, Buffer.from('A3 synthetic unsupported media bytes\n', 'utf8'));
  const invalidProbe = exec(ffprobePath, ['-v', 'error', '-show_format', '-show_streams', invalidMedia], { allowFailure: true });
  const invalidDiagnostic = invalidProbe.stderr.includes('Invalid data found when processing input')
    ? 'Invalid data found when processing input'
    : invalidProbe.stderr.trim().replaceAll(work, '<synthetic-work>');
  const unsupportedMedia = { rejected: invalidProbe.code !== 0, exitCode: invalidProbe.code, diagnostic: invalidDiagnostic.slice(0, 500) };
  assert(unsupportedMedia.rejected, 'ffprobe accepted invalid synthetic media');

  const cancelOutput = path.join(outputs, 'cancelled.partial.mp4');
  const cancelInputHash = await binaryHash(videoSource);
  const child = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-re', '-stream_loop', '-1', '-i', videoSource,
    '-map', '0:v:0', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', cancelOutput,
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let cancelDiagnostic = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { cancelDiagnostic = `${cancelDiagnostic}${chunk}`.slice(-800); });
  const cancelStarted = performance.now();
  const cancellation = await new Promise((resolve, reject) => {
    let sent = false;
    const timer = setTimeout(() => {
      sent = true;
      child.kill();
    }, 900);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ sent, code, signal, elapsedMs: Number((performance.now() - cancelStarted).toFixed(2)) });
    });
  });
  assert(cancellation.sent && (cancellation.code !== 0 || cancellation.signal), 'FFmpeg process did not terminate through the cancellation test');
  const partialExisted = await stat(cancelOutput).then(() => true, () => false);
  await rm(cancelOutput, { force: true });
  assert((await binaryHash(videoSource)) === cancelInputHash, 'Cancellation changed the synthetic original');
  assert(!(await stat(cancelOutput).then(() => true, () => false)), 'Cancelled temporary output was not cleaned');

  for (const [file, before] of sourceHashesBefore) {
    assert((await binaryHash(file)) === before, `Source changed during conversion: ${path.basename(file)}`);
  }

  const sharpPackage = JSON.parse(await readFile(path.join(root, 'node_modules/sharp/package.json'), 'utf8'));
  const platformPackage = JSON.parse(await readFile(path.join(root, 'node_modules/@img/sharp-win32-x64/package.json'), 'utf8'));
  const result = {
    schemaVersion: 1,
    executedAt: new Date().toISOString(),
    host: {
      os: `${os.type()} ${os.release()} ${os.arch()}`,
      node: process.version,
      cpu: os.cpus()[0]?.model,
      logicalCores: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    sharp: {
      packageVersion: sharpPackage.version,
      packageLicense: sharpPackage.license,
      platformPackage: platformPackage.name,
      platformPackageVersion: platformPackage.version,
      platformPackageLicense: platformPackage.license,
      nativeAndCodecVersions: sharp.versions,
      formatFlags: Object.fromEntries(Object.entries(sharp.format).map(([name, value]) => [name, { input: value.input, output: value.output }])),
      sources: imageSourcesInfo,
      outputs: imageOutputs,
      gifEncode,
      exifBehavior: {
        syntheticSourceBytes: (await stat(exifSource)).size,
        sourceHasExif: true,
        defaultOutputStrippedExif: !strippedExifMetadata.exif,
        keepExifOutputPreservedExif: Boolean(keptExifMetadata.exif?.length),
      },
      thumbnail: { file: 'thumbnail.webp', width: thumbMeta.width, height: thumbMeta.height, bytes: (await stat(thumbPath)).size, elapsedMs: thumbRun.elapsedMs },
      unsupportedInput: unsupportedImage,
      pdfInputOutputFlags: sharp.format.pdf,
      sourceHashesPreserved: true,
    },
    ffmpeg: {
      distribution: 'Gyan FFmpeg full build installed through WinGet (Gyan.FFmpeg 8.0.1)',
      ffmpegVersion: ffmpegVersion.split(/\r?\n/)[0],
      ffprobeVersion: ffprobeVersion.split(/\r?\n/)[0],
      ffmpegSha256: await binaryHash(ffmpegPath),
      ffprobeSha256: await binaryHash(ffprobePath),
      licenseOutput: ffmpegLicense.trim().split(/\r?\n/).slice(0, 7),
      buildConfiguration: ffmpegBuildconf.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      gplEnabled: ffmpegBuildconf.includes('--enable-gpl'),
      version3Enabled: ffmpegBuildconf.includes('--enable-version3'),
      nonfreeEnabled: ffmpegBuildconf.includes('--enable-nonfree'),
      encoderAvailability,
      syntheticSources: {
        wav: { bytes: (await stat(audioSource)).size, streams: sourceAudioProbe.streams.map(({ codec_type, codec_name, sample_rate, channels }) => ({ codec_type, codec_name, sample_rate, channels })) },
        mkv: { bytes: (await stat(videoSource)).size, formatName: sourceVideoProbe.format.format_name, streams: sourceVideoProbe.streams.map(({ codec_type, codec_name, width, height, sample_rate, channels }) => ({ codec_type, codec_name, width, height, sample_rate, channels })) },
      },
      conversions: mediaResults,
      unsupportedInput: unsupportedMedia,
      cancellation: { ...cancellation, partialOutputExisted: partialExisted, temporaryRemoved: true, originalSha256Preserved: true, diagnostic: cancelDiagnostic.trim().slice(0, 400) },
      sourceHashesPreserved: true,
    },
    result: 'passed',
    scopeLimit: 'Synthetic samples only. Timing and output sizes describe this host and these sample dimensions.'
  };
  await writeFile(path.join(root, 'results.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ result: result.result, sharp: result.sharp.packageVersion, libvips: result.sharp.nativeAndCodecVersions.vips, ffmpeg: result.ffmpeg.ffmpegVersion, testedProfiles: Object.keys(mediaResults), cancellation: result.ffmpeg.cancellation, results: 'results.json' }, null, 2));
}
