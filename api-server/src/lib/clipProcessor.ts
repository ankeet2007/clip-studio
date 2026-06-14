import { execFile, spawn } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import os from "os";
import { inArray, eq } from "drizzle-orm";
import { db, clipsTable } from "@workspace/db";
import { logger } from "./logger";

const execFileAsync = promisify(execFile);

const OUTPUT_DIR = process.env.CLIPS_OUTPUT_DIR ?? "/home/runner/workspace/clips_output";
const UPLOADS_DIR = process.env.UPLOADS_DIR ?? "/home/runner/workspace/uploads";
const FONTS_DIR = "/home/runner/workspace/assets/fonts";
const ANTON_FONT = path.join(FONTS_DIR, "Anton-Regular.ttf");
const COOKIES_FILE = path.join(os.tmpdir(), "youtube_cookies.txt");

/**
 * If the YOUTUBE_COOKIES env var is set, writes its content to a temp file
 * and returns ["--cookies", "<path>"] to append to the yt-dlp command.
 * This unlocks higher-quality formats on live recordings and age-restricted videos.
 */
function getCookiesArgs(): string[] {
  const cookies = process.env.YOUTUBE_COOKIES;
  if (!cookies || !cookies.trim()) return [];
  try {
    fs.writeFileSync(COOKIES_FILE, cookies.trim(), { mode: 0o600 });
    logger.info("YouTube cookies loaded — high-quality formats unlocked");
    return ["--cookies", COOKIES_FILE];
  } catch (err) {
    logger.warn({ err }, "Failed to write YouTube cookies file — continuing without cookies");
    return [];
  }
}

// Clean regular weight for headline text — matches reference style
const CAPTION_FONTS = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
];

// --- Simple concurrency queue: max 2 simultaneous jobs ---
const MAX_CONCURRENT = 2;
let activeJobs = 0;
const jobQueue: Array<() => void> = [];

function drainQueue() {
  while (activeJobs < MAX_CONCURRENT && jobQueue.length > 0) {
    const next = jobQueue.shift()!;
    activeJobs++;
    next();
  }
}

export function enqueueClipJob(fn: () => Promise<void>): void {
  jobQueue.push(() => {
    fn().finally(() => {
      activeJobs--;
      drainQueue();
    });
  });
  drainQueue();
}

/**
 * The in-memory job queue does not survive a server restart. Any clip left in
 * "pending" or "processing" was interrupted and will never resume on its own,
 * so it would otherwise stay in that state forever. On startup we mark those
 * rows as "error" with a clear message so the user can retry them.
 */
export async function reconcileInterruptedJobs(): Promise<void> {
  try {
    const interrupted = await db
      .update(clipsTable)
      .set({
        status: "error",
        progress: 0,
        errorMessage:
          "Processing was interrupted by a server restart. Click retry to run this clip again.",
      })
      .where(inArray(clipsTable.status, ["pending", "processing"]))
      .returning({ id: clipsTable.id });

    if (interrupted.length > 0) {
      logger.warn(
        { count: interrupted.length, ids: interrupted.map((c) => c.id) },
        "Reconciled interrupted clip jobs after restart",
      );
    }
  } catch (err) {
    logger.error({ err }, "Failed to reconcile interrupted clip jobs");
  }
}

export function getOutputDir(): string {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  return OUTPUT_DIR;
}

export function getOutputFilePath(filename: string): string {
  return path.join(getOutputDir(), filename);
}

export function getUploadsDir(): string {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
  return UPLOADS_DIR;
}


function findYtDlp(): string {
  const candidates = [
    "/home/runner/workspace/.pythonlibs/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "yt-dlp";
}

function findPython(): string {
  const candidates = [
    "/home/runner/workspace/.pythonlibs/bin/python3",
    "/usr/local/bin/python3",
    "/usr/bin/python3",
    "python3",
  ];
  for (const c of candidates) {
    if (c === "python3" || fs.existsSync(c)) return c;
  }
  return "python3";
}

// Path to the Python script that renders headline text (with emoji) to a PNG.
// tsx sets __dirname to the artifact root, not the source file dir, so derive workspace root
// by climbing until we find the scripts directory (or fall back to the known Replit path).
function findWorkspaceRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "scripts", "render_headline.py"))) return dir;
    dir = path.dirname(dir);
  }
  // Stable fallback for Replit
  return "/home/runner/workspace";
}
const RENDER_HEADLINE_SCRIPT = path.join(findWorkspaceRoot(), "scripts", "render_headline.py");

function findFont(): string {
  for (const f of CAPTION_FONTS) {
    if (fs.existsSync(f)) return f;
  }
  // Last resort: try Anton
  if (fs.existsSync(ANTON_FONT)) return ANTON_FONT;
  return CAPTION_FONTS[0]!;
}

function timeToSeconds(ts: string): number {
  const parts = ts.split(":").map(Number);
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  return parts[0]!;
}

/**
 * Normalises a YouTube URL so protocol/host casing differences don't trip up yt-dlp.
 * e.g. "Https://youtu.be/..." → "https://youtu.be/..."
 */
export function normalizeYoutubeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.toString();
  } catch {
    // If URL() can't parse it, just lowercase the protocol prefix
    return url.replace(/^https?:\/\//i, (m) => m.toLowerCase());
  }
}

/**
 * Extracts a clean, human-readable error from a raw yt-dlp / ffmpeg command error.
 * Strips the "Command failed: ..." prefix and keeps only ERROR/WARNING lines.
 */
const NOISE_PATTERNS = [
  /No supported JavaScript runtime/,
  /js-runtimes RUNTIME/,
  /youtube\.com\/watch/,
];

function isNoiseLine(line: string): boolean {
  return NOISE_PATTERNS.some((re) => re.test(line));
}

export function parseProcessingError(raw: string): string {
  // Detect process kill / timeout before parsing stderr content
  if (/killed|timed out|SIGTERM|SIGKILL/i.test(raw) && !raw.includes("ERROR:")) {
    return "Download timed out — the clip may be too long or the connection was slow. Try a shorter segment.";
  }

  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);

  // Look for explicit ERROR lines first (most informative)
  const errorLines = lines.filter((l) => l.startsWith("ERROR:"));
  if (errorLines.length > 0) {
    return errorLines
      .map((l) => l.replace(/^ERROR:\s*\[youtube[^\]]*\]\s*[^:]+:\s*/, "").replace(/^ERROR:\s*/, ""))
      .join(" | ")
      .slice(0, 400);
  }

  // Fall back to meaningful WARNING lines (skip known noise)
  const warnLines = lines.filter(
    (l) => l.startsWith("WARNING:") && !isNoiseLine(l)
  );
  if (warnLines.length > 0) {
    return warnLines.map((l) => l.replace(/^WARNING:\s*/, "")).join(" | ").slice(0, 400);
  }

  // Last resort: strip "Command failed: <command>" prefix, skip noise lines
  const withoutCmd = raw.replace(/^Command failed:[^\n]+\n?/, "").trim();
  const meaningfulLines = withoutCmd.split("\n").map((l) => l.trim()).filter((l) => l && !isNoiseLine(l));
  const cleaned = meaningfulLines.join(" | ").slice(0, 300);
  return cleaned || "Download failed — check the URL and timestamps.";
}

function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\u2019")
    .replace(/:/g, "\\\\:")
    .replace(/\[/g, "\\\\[")
    .replace(/\]/g, "\\\\]")
    .replace(/,/g, "\\\\,")
    .replace(/;/g, "\\\\;")
    .replace(/\n/g, " ");
}


/**
 * Creates a throttled progress updater for a clip. Writes at most once per second
 * to avoid hammering the DB during long ffmpeg encodes.
 */
function makeProgressUpdater(clipId: number) {
  let lastTime = 0;
  return async (pct: number, force = false) => {
    if (!clipId) return;
    const now = Date.now();
    if (!force && now - lastTime < 1000) return;
    lastTime = now;
    try {
      await db
        .update(clipsTable)
        .set({ progress: Math.min(100, Math.max(0, Math.round(pct))) })
        .where(eq(clipsTable.id, clipId));
    } catch {
      // Non-fatal — progress is best-effort
    }
  };
}

/**
 * Spawns a child process, accumulates stderr for error reporting, and calls
 * onLine for every line of output (both stdout and stderr) for progress parsing.
 *
 * stallTimeoutMs: if no output is received for this long, the process is killed.
 * This catches silently hung downloads where the TCP connection stalls mid-transfer
 * and ffmpeg waits forever for bytes that never arrive.
 */
function spawnProcess(
  cmd: string,
  args: string[],
  timeoutMs: number,
  onLine?: (line: string) => void,
  stallTimeoutMs = 90_000
): Promise<void> {
  return new Promise((resolve, reject) => {
    // detached: true puts yt-dlp in its own process group so that killing the group
    // also kills any grandchild ffmpeg processes spawned by yt-dlp. Without this,
    // killing yt-dlp leaves internal ffmpeg running as an orphan indefinitely.
    const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    let stderrBuf = "";
    let done = false;

    function fail(msg: string) {
      if (done) return;
      done = true;
      clearTimeout(hardTimer);
      clearTimeout(stallTimer);
      // Kill the entire process group (negative PID) to take down yt-dlp + its ffmpeg children
      try { process.kill(-proc.pid!, "SIGKILL"); } catch { proc.kill("SIGKILL"); }
      reject(new Error(msg));
    }

    // Stall timer: reset every time data arrives; fires if nothing comes for stallTimeoutMs
    let stallTimer: ReturnType<typeof setTimeout>;
    function resetStall() {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(
        () => fail(`killed|download stalled — no output for ${stallTimeoutMs / 1000}s\n${stderrBuf}`),
        stallTimeoutMs
      );
    }
    resetStall();

    // Hard upper-bound timeout
    const hardTimer = setTimeout(
      () => fail(`killed|timed out after ${timeoutMs / 1000}s\n${stderrBuf}`),
      timeoutMs
    );

    function handleData(chunk: Buffer, isStderr: boolean) {
      resetStall();
      const text = chunk.toString();
      if (isStderr) stderrBuf += text;
      if (onLine) {
        // yt-dlp progress lines end with \r; split on both so they fire the callback.
        for (const line of text.split(/\r?\n|\r/)) {
          if (line.trim()) onLine(line);
        }
      }
    }

    proc.stdout.on("data", (c: Buffer) => handleData(c, false));
    proc.stderr.on("data", (c: Buffer) => handleData(c, true));

    proc.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(hardTimer);
      clearTimeout(stallTimer);
      if (code === 0 || code === null) {
        resolve();
      } else {
        reject(new Error(stderrBuf || `Process exited with code ${code}`));
      }
    });

    proc.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(hardTimer);
      clearTimeout(stallTimer);
      reject(err);
    });
  });
}

/**
 * Builds the base yt-dlp arg list shared by all download attempts.
 */
function buildYtDlpArgs(
  section: string,
  format: string,
  outTemplate: string,
  youtubeUrl: string,
  cookiesArgs: string[],
  extraArgs: string[] = []
): string[] {
  return [
    "--no-playlist",
    "--download-sections", section,
    // NOTE: --force-keyframes-at-cuts is intentionally omitted.
    // On live recordings it spawns an internal ffmpeg that must seek through the entire
    // CDN stream to reach the cut point, hanging indefinitely on long videos.
    "--format", format,
    "--merge-output-format", "mp4",
    ...cookiesArgs,
    ...extraArgs,
    "-o", outTemplate,
    "--no-part",
    "--progress",
    "--newline",
    "--socket-timeout", "30",
    "--retries", "10",
    "--fragment-retries", "inf",
    youtubeUrl,
  ];
}

/**
 * Downloads the exact time segment from YouTube using yt-dlp --download-sections.
 *
 * Strategy:
 *   1. DASH 1080p via native downloader + concurrent fragments.
 *      --downloader native makes yt-dlp download each DASH segment individually from the
 *      manifest, then ffmpeg muxes from local files. This avoids yt-dlp's internal ffmpeg
 *      seeking sequentially through the full CDN stream (which hangs on archived live recordings
 *      because it has to read through all content before the timestamp first).
 *      --concurrent-fragments 4 downloads up to 4 segments in parallel for faster throughput.
 *   2. 720p DASH via native downloader (same approach, smaller file).
 *   3. Format 18 = 360p H.264+AAC combined progressive mp4 — final reliable fallback.
 *      Not DASH; moov-atom index lets ffmpeg seek without reading the whole file.
 *
 * Returns the path to the downloaded temp file.
 */
async function downloadSegment(
  ytDlp: string,
  youtubeUrl: string,
  startTime: string,
  endTime: string,
  tmpId: string,
  onProgress: (pct: number) => void
): Promise<string> {
  const tmpDir = os.tmpdir();
  const section = `*${startTime}-${endTime}`;
  const cookiesArgs = getCookiesArgs();

  // Native downloader args: download DASH segments individually (no full-stream seek),
  // with 4 concurrent connections for faster throughput.
  const nativeArgs = ["--downloader", "native", "--concurrent-fragments", "4"];

  const attempts: Array<{ format: string; label: string; stallMs: number; hardMs: number; extraArgs?: string[] }> = [
    {
      // Native downloader + 1080p DASH. Works on regular videos and archived live recordings
      // because segments are downloaded individually from the manifest (no CDN stream seek).
      format: "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080][ext=mp4]+bestaudio/bestvideo[height<=1080]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio",
      label: "DASH 1080p (native)",
      stallMs: 60_000,  // 1 min stall — native downloader reports progress; stall = real problem
      hardMs: 480_000,  // 8 min hard cap — ~50MB at ~100KB/s with 4 concurrent connections
      extraArgs: nativeArgs,
    },
    {
      // Native downloader + 720p DASH fallback.
      format: "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720][ext=mp4]+bestaudio/bestvideo[height<=720]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio",
      label: "DASH 720p (native)",
      stallMs: 60_000,
      hardMs: 300_000,  // 5 min — smaller file, 720p
      extraArgs: nativeArgs,
    },
    {
      // Format 18 = 360p H.264+AAC combined progressive mp4.
      // Not DASH — moov-atom byte-range seek is reliable even on archived live streams.
      format: "18/best[ext=mp4]/best",
      label: "progressive mp4 fallback (360p)",
      stallMs: 180_000,
      hardMs: 300_000,
    },
  ];

  let lastError: Error = new Error("no attempts made");

  for (const [i, attempt] of attempts.entries()) {
    const attemptId = i === 0 ? tmpId : `${tmpId}_fb${i}`;
    const outTemplate = path.join(tmpDir, `clip_raw_${attemptId}.%(ext)s`);

    logger.info(
      { youtubeUrl, startTime, endTime, section, format: attempt.format, attempt: i + 1 },
      "Downloading segment via yt-dlp"
    );

    try {
      await spawnProcess(
        ytDlp,
        buildYtDlpArgs(section, attempt.format, outTemplate, youtubeUrl, cookiesArgs, attempt.extraArgs ?? []),
        attempt.hardMs,
        (line) => {
          const m = line.match(/\[download\]\s+(\d+\.?\d*)%/);
          if (m) {
            const ytPct = parseFloat(m[1]!);
            // Map yt-dlp's 0-100% → overall progress 2-48%
            onProgress(2 + ytPct * 0.46);
          }
        },
        attempt.stallMs
      );

      // Locate the output file
      const candidates = ["mp4", "mkv", "webm"].map((ext) =>
        path.join(tmpDir, `clip_raw_${attemptId}.${ext}`)
      );
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
      }
      const files = fs.readdirSync(tmpDir).filter((f) => f.startsWith(`clip_raw_${attemptId}`));
      if (files.length > 0) return path.join(tmpDir, files[0]!);

      throw new Error("yt-dlp finished but no output file found");
    } catch (err) {
      lastError = err as Error;
      const msg = lastError.message;
      const isStallOrTimeout = /killed\|/.test(msg) || msg.includes("stalled") || msg.includes("timed out");

      if (!isStallOrTimeout || i === attempts.length - 1) {
        // Real error, or we've exhausted all fallbacks
        throw lastError;
      }

      logger.warn(
        { attempt: attempt.label, error: msg.slice(0, 200) },
        `Download stalled on ${attempt.label}; retrying with ${attempts[i + 1]!.label}`
      );
    }
  }

  throw lastError;
}

export async function processClip(
  youtubeUrl: string | null,
  startTime: string,
  endTime: string,
  headline: string,
  outputFilename: string,
  mode: "edited" | "raw" = "edited",
  channelHandle = "",
  clipId = 0,
  localFilePath?: string
): Promise<void> {
  const isLocalFile = !!localFilePath;
  const ytDlp = findYtDlp();
  const outputDir = getOutputDir();
  const finalOutputPath = path.join(outputDir, outputFilename);

  const startSeconds = timeToSeconds(startTime);
  const endSeconds = timeToSeconds(endTime);
  const duration = endSeconds - startSeconds;

  if (duration <= 0) throw new Error("End time must be after start time");

  const updateProgress = makeProgressUpdater(clipId);

  // Unique ID for temp files per clip to avoid collisions between concurrent jobs
  const tmpId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;

  let tmpInputPath: string | null = null;

  try {
    if (isLocalFile) {
      // Step 1 (local): file already on disk — skip yt-dlp entirely
      tmpInputPath = localFilePath;
      logger.info({ tmpInputPath, mode }, "Using local uploaded file");
      await updateProgress(50, true);
    } else {
      // Step 1 (YouTube): download the exact segment — reports 2-48% progress
      await updateProgress(2, true);
      tmpInputPath = await downloadSegment(
        ytDlp,
        youtubeUrl!,
        startTime,
        endTime,
        tmpId,
        (pct) => { void updateProgress(pct); }
      );
      logger.info({ tmpInputPath, mode }, "Segment downloaded");
      await updateProgress(50, true);
    }

    // Raw mode: for local files trim with ffmpeg copy; for YouTube just copy the downloaded segment
    if (mode === "raw") {
      if (isLocalFile) {
        await spawnProcess("ffmpeg", [
          "-y",
          "-ss", startTime,
          "-i", tmpInputPath,
          "-t", String(duration),
          "-c", "copy",
          finalOutputPath,
        ], 300_000);
      } else {
        fs.copyFileSync(tmpInputPath, finalOutputPath);
      }
      logger.info({ finalOutputPath }, "Raw clip saved (no compositing)");
      return;
    }

    logger.info({ tmpInputPath }, "Building filter graph for edited mode");

    // Step 2: Render headline text to a transparent PNG via Python.
    // This handles emoji (pilmoji/Twemoji) which ffmpeg drawtext cannot render.
    const canvasW = 1080;
    const canvasH = 1920;
    const videoW = 1080;
    const videoH = 608;
    const videoY = Math.floor((canvasH - videoH) / 2);

    const fontSize = 58;
    const lineSpacing = 18;

    const fontFile = findFont();
    let tmpPngPath: string | null = null;
    let pngHeight = 0;

    if (headline && headline.trim()) {
      tmpPngPath = path.join(os.tmpdir(), `clip_hl_${tmpId}.png`);
      const renderParams = JSON.stringify({
        text: headline,
        font_path: fontFile,
        font_size: fontSize,
        line_spacing: lineSpacing,
        max_chars: 38,
        canvas_width: canvasW,
        output_path: tmpPngPath,
      });
      const python3 = findPython();
      const renderOutput = await execFileAsync(python3, [RENDER_HEADLINE_SCRIPT, renderParams], { timeout: 30000 });
      const renderResult = JSON.parse(renderOutput.stdout.trim()) as { height: number; lines: number };
      pngHeight = renderResult.height;
      logger.info({ tmpPngPath, pngHeight, lines: renderResult.lines }, "Headline PNG rendered");
    }

    await updateProgress(53, true);

    // Position: center the headline PNG vertically in the top white bar
    const hlY = Math.max(30, Math.floor((videoY - pngHeight) / 2));

    // Step 3: Build ffmpeg filter graph
    // Inputs: [0] = downloaded video clip, [1] = headline PNG (if headline is set)
    const extraInputs: string[] = [];
    const filters: string[] = [
      `[0:v]scale=${videoW}:-2:flags=lanczos,crop=${videoW}:${videoH},unsharp=5:5:1.0:5:5:0.0[vid]`,
      `color=white:size=${canvasW}x${canvasH}:rate=60[bg]`,
      `[bg][vid]overlay=0:${videoY}[composed]`,
    ];
    let prevLabel = "composed";

    if (tmpPngPath && pngHeight > 0) {
      // -loop 1 makes the still PNG repeat for the full video duration; -t (below) cuts it
      extraInputs.push("-loop", "1", "-i", tmpPngPath);
      filters.push(`[1:v]format=rgba[hl]`);
      filters.push(`[${prevLabel}][hl]overlay=x=0:y=${hlY}[after_hl]`);
      prevLabel = "after_hl";
    }

    // Channel handle watermark: small white text with shadow near the bottom of the video frame
    if (channelHandle && channelHandle.trim()) {
      const safeHandle = escapeDrawtext(channelHandle.trim());
      const handleY = videoY + videoH - 44;
      filters.push(
        `[${prevLabel}]drawtext=` +
        `text='${safeHandle}':` +
        `fontfile='${fontFile}':` +
        `fontsize=28:` +
        `fontcolor=white:` +
        `shadowx=2:shadowy=2:shadowcolor=black@0.8:` +
        `x=(w-text_w)/2:` +
        `y=${handleY}` +
        `[out]`
      );
    } else {
      filters.push(`[${prevLabel}]null[out]`);
    }

    const filterComplex = filters.join(";");

    // Step 4: Run ffmpeg, reporting 55-95% progress by parsing time= lines
    // For local files, add fast input-side seek (-ss before -i) so ffmpeg trims precisely
    const ffmpegArgs: string[] = [
      "-y",
      ...(isLocalFile ? ["-ss", startTime] : []),
      "-i", tmpInputPath,
      ...extraInputs,
      "-filter_complex", filterComplex,
      "-map", "[out]",
      "-map", "0:a?",
      "-c:v", "libx264",
      "-preset", "slow",
      "-crf", "14",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "256k",
      "-t", String(duration),
      "-movflags", "+faststart",
      finalOutputPath,
    ];

    logger.info({ pngHeight, channelHandle, fontFile }, "Starting ffmpeg");

    await spawnProcess("ffmpeg", ffmpegArgs, 600000, (line) => {
      // ffmpeg progress: "... time=00:00:04.10 ..."
      const m = line.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
      if (m) {
        const elapsed =
          parseInt(m[1]!) * 3600 + parseInt(m[2]!) * 60 + parseFloat(m[3]!);
        const ratio = Math.min(elapsed / duration, 1);
        // Map ffmpeg 0-100% → overall 55-95%
        void updateProgress(55 + ratio * 40);
      }
    });

    logger.info({ finalOutputPath }, "Clip processing complete");
  } finally {
    // Clean up all temp files for this job (video segment + headline PNG).
    try {
      const tmpDir = os.tmpdir();
      const leftovers = fs
        .readdirSync(tmpDir)
        .filter((f) => f.includes(tmpId));
      for (const f of leftovers) {
        const p = path.join(tmpDir, f);
        if (fs.existsSync(p)) {
          fs.unlinkSync(p);
          logger.info({ tmpFile: p }, "Cleaned up temp file");
        }
      }
    } catch (cleanupErr) {
      logger.warn({ cleanupErr, tmpId }, "Failed to clean up temp files");
    }
  }
}
