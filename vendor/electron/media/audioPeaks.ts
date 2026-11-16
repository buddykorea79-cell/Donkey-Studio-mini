// Mini adapter: keep the original V.Clip analysis independent of Electron.
export function resolveFfmpeg(): string | null {
  return process.env.MINI_FFMPEG || process.env.FFMPEG_PATH || null;
}
