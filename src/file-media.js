import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { extname, isAbsolute, join, delimiter } from 'node:path';

const exec = promisify(execFile);
export const AUDIO_EXTENSIONS = ['wav', 'mp3', 'm4a', 'mp4', 'mov', 'flac', 'ogg', 'webm', 'mkv', 'aiff', 'aif', 'aac'];
export const FILE_SAMPLE_RATE = 16000;
export const FILE_CHUNK_SECONDS = 20;
const FORMATS = 'wav,mp3,flac,ogg,mov,matroska,webm,aiff,aac';
const inputOptions = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', FORMATS];

export async function findMediaBinary(name) {
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name + (process.platform === 'win32' ? '.exe' : ''));
    try { await access(candidate, constants.X_OK); return candidate; } catch {}
  }
  return null;
}

export async function sourceIdentity(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || !AUDIO_EXTENSIONS.includes(extname(path).slice(1).toLowerCase())) {
    throw new Error('Choose a supported audio or video file.');
  }
  const info = await stat(path);
  if (!info.isFile() || info.size === 0) throw new Error('The source must be a nonempty file.');
  return { size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, dev: info.dev };
}

export async function probeMedia(path, { ffprobe, signal } = {}) {
  if (!ffprobe) throw new Error('FFmpeg is required for file transcription. Install FFmpeg, then reopen this window.');
  try {
    const { stdout } = await exec(ffprobe, ['-v', 'error', ...inputOptions, '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', path], { signal, timeout: 20000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' });
    const data = JSON.parse(stdout);
    const duration = Number(data.format?.duration);
    if (!data.streams?.some(stream => stream.codec_type === 'audio') || !Number.isFinite(duration) || duration <= 0 || duration > 6 * 3600) {
      throw new Error('unsupported');
    }
    return duration;
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('Could not read audio from this file. Choose a supported recording up to six hours long.');
  }
}

export async function decodeMediaChunk(path, start, duration, { ffmpeg, signal } = {}) {
  if (!ffmpeg) throw new Error('FFmpeg is required for file transcription.');
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0 || duration > FILE_CHUNK_SECONDS + 2) throw new Error('Invalid audio section.');
  try {
    const { stdout } = await exec(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...inputOptions, '-ss', String(start), '-i', path, '-t', String(duration), '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(FILE_SAMPLE_RATE), '-f', 's16le', 'pipe:1'], {
      signal, timeout: 30000, maxBuffer: (FILE_CHUNK_SECONDS + 3) * FILE_SAMPLE_RATE * 2, encoding: 'buffer', killSignal: 'SIGKILL',
    });
    if (!stdout.length || stdout.length % 2) throw new Error('empty');
    return stdout;
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('Could not decode this audio section. Check that the original file is still available.');
  }
}

// Prefer ending a section in a short quiet interval near its end, preserving
// word boundaries without feeding the same words to the recognizer twice.
export function sectionLength(pcm, wantedSeconds, isLast) {
  const actual = pcm.length / 2 / FILE_SAMPLE_RATE;
  if (isLast || actual < wantedSeconds - 0.1) return actual;
  const frameSamples = 320;
  let quietStart = null;
  let best = null;
  for (let sample = Math.max(0, Math.floor((wantedSeconds - 3) * FILE_SAMPLE_RATE)); sample + frameSamples <= pcm.length / 2; sample += frameSamples) {
    let sum = 0;
    for (let i = sample; i < sample + frameSamples; i++) { const n = pcm.readInt16LE(i * 2); sum += n * n; }
    if (Math.sqrt(sum / frameSamples) < 150) {
      quietStart ??= sample;
      if (sample + frameSamples - quietStart >= FILE_SAMPLE_RATE * 0.2) best = (quietStart + sample + frameSamples) / 2 / FILE_SAMPLE_RATE;
    } else quietStart = null;
  }
  return best || Math.min(actual, wantedSeconds);
}
