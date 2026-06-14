import { Router, type IRouter } from "express";
import fs from "fs";
import path from "path";
import busboy from "busboy";
import { eq, desc, count } from "drizzle-orm";
import { db, clipsTable } from "@workspace/db";
import {
  CreateClipBody,
  GetClipParams,
  DeleteClipParams,
  ListClipsResponse,
  GetClipResponse,
  GetClipStatsResponse,
} from "@workspace/api-zod";
import { processClip, enqueueClipJob, getOutputFilePath, getUploadsDir, normalizeYoutubeUrl, parseProcessingError } from "../lib/clipProcessor";
import { logger } from "../lib/logger";
import { readSettings } from "../lib/settings";

const router: IRouter = Router();

router.get("/clips/stats", async (req, res): Promise<void> => {
  const rows = await db
    .select({ status: clipsTable.status, cnt: count() })
    .from(clipsTable)
    .groupBy(clipsTable.status);

  const stats = { total: 0, pending: 0, processing: 0, done: 0, error: 0 };
  for (const row of rows) {
    const n = Number(row.cnt);
    stats.total += n;
    if (row.status === "pending") stats.pending = n;
    else if (row.status === "processing") stats.processing = n;
    else if (row.status === "done") stats.done = n;
    else if (row.status === "error") stats.error = n;
  }

  res.json(GetClipStatsResponse.parse(stats));
});

router.get("/clips", async (req, res): Promise<void> => {
  const clips = await db
    .select()
    .from(clipsTable)
    .orderBy(desc(clipsTable.createdAt));

  res.json(ListClipsResponse.parse(clips));
});

function dispatchClipJob(
  clipId: number,
  youtubeUrl: string | null,
  startTime: string,
  endTime: string,
  headline: string,
  outputFilename: string,
  mode: "edited" | "raw" = "edited",
  localFilePath?: string
) {
  const { channelHandle } = readSettings();

  enqueueClipJob(async () => {
    // Await the status update BEFORE starting work so processClip can never
    // write "done" before "processing" lands (the old fire-and-forget race).
    try {
      await db.update(clipsTable)
        .set({ status: "processing" })
        .where(eq(clipsTable.id, clipId))
        .execute();
    } catch (err: unknown) {
      logger.error({ err, clipId }, "Failed to mark clip as processing");
    }

    await processClip(youtubeUrl, startTime, endTime, headline, outputFilename, mode, channelHandle, clipId, localFilePath)
      .then(async () => {
        await db
          .update(clipsTable)
          .set({ status: "done", progress: 100, outputFilename })
          .where(eq(clipsTable.id, clipId));
      })
      .catch(async (err: unknown) => {
        const raw = err instanceof Error ? err.message : String(err);
        const msg = parseProcessingError(raw);
        await db
          .update(clipsTable)
          .set({ status: "error", progress: 0, errorMessage: msg })
          .where(eq(clipsTable.id, clipId));
      });
  });
}

router.post("/clips", async (req, res): Promise<void> => {
  const parsed = CreateClipBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { startTime, endTime } = parsed.data;
  const youtubeUrl = normalizeYoutubeUrl(parsed.data.youtubeUrl);
  const headline = parsed.data.headline ?? "";
  const mode = (parsed.data.mode ?? "edited") as "edited" | "raw";

  const [clip] = await db
    .insert(clipsTable)
    .values({ youtubeUrl, startTime, endTime, headline, mode, sourceType: "youtube", status: "pending" })
    .returning();

  if (!clip) {
    res.status(500).json({ error: "Failed to create clip" });
    return;
  }

  res.status(201).json(GetClipResponse.parse(clip));

  const outputFilename = `clip_${clip.id}_${Date.now()}.mp4`;
  dispatchClipJob(clip.id, youtubeUrl, startTime, endTime, headline, outputFilename, mode);
});

/**
 * POST /clips/upload — stream a local video file (up to 20 GB) to disk then process it.
 * Accepts multipart/form-data with fields: file (required), startTime, endTime, headline, mode.
 */
router.post("/clips/upload", (req, res): void => {
  const uploadsDir = getUploadsDir();
  const tmpId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;

  let startTime = "00:00:00";
  let endTime = "00:01:00";
  let headline = "";
  let mode: "edited" | "raw" = "edited";
  let savedFilePath: string | null = null;
  let savedFileName: string | null = null;
  let fileWritePromise: Promise<void> | null = null;

  let bb: ReturnType<typeof busboy>;
  try {
    bb = busboy({
      headers: req.headers,
      limits: { fileSize: 20 * 1024 * 1024 * 1024 },
    });
  } catch {
    res.status(400).json({ error: "Invalid multipart request" });
    return;
  }

  bb.on("field", (name: string, value: string) => {
    if (name === "startTime") startTime = value.trim() || "00:00:00";
    if (name === "endTime") endTime = value.trim() || "00:01:00";
    if (name === "headline") headline = value;
    if (name === "mode" && (value === "edited" || value === "raw")) mode = value;
  });

  bb.on("file", (_name: string, stream: NodeJS.ReadableStream, info: { filename: string; encoding: string; mimeType: string }) => {
    const ext = path.extname(info.filename).toLowerCase() || ".mp4";
    const filename = `upload_${tmpId}${ext}`;
    savedFileName = info.filename || filename;
    savedFilePath = path.join(uploadsDir, filename);

    const writeStream = fs.createWriteStream(savedFilePath);
    (stream as NodeJS.ReadableStream).pipe(writeStream);

    fileWritePromise = new Promise<void>((resolve, reject) => {
      writeStream.on("finish", resolve);
      writeStream.on("error", (err) => {
        reject(err);
      });
      stream.on("error", (err: Error) => {
        writeStream.destroy();
        reject(err);
      });
    });
  });

  bb.on("finish", () => {
    void (async () => {
      try {
        if (!savedFilePath || !fileWritePromise) {
          res.status(400).json({ error: "No video file received" });
          return;
        }

        await fileWritePromise;

        const stat = fs.statSync(savedFilePath);
        if (stat.size === 0) {
          fs.unlinkSync(savedFilePath);
          res.status(400).json({ error: "Uploaded file is empty" });
          return;
        }

        const [clip] = await db
          .insert(clipsTable)
          .values({
            youtubeUrl: null,
            startTime,
            endTime,
            headline,
            mode,
            sourceType: "local",
            localFilePath: savedFilePath,
            localFileName: savedFileName,
            status: "pending",
          })
          .returning();

        if (!clip) {
          fs.unlinkSync(savedFilePath);
          res.status(500).json({ error: "Failed to create clip record" });
          return;
        }

        res.status(201).json(GetClipResponse.parse(clip));

        const outputFilename = `clip_${clip.id}_${Date.now()}.mp4`;
        dispatchClipJob(clip.id, null, startTime, endTime, headline, outputFilename, mode, savedFilePath);
      } catch (err) {
        if (savedFilePath) {
          try { if (fs.existsSync(savedFilePath)) fs.unlinkSync(savedFilePath); } catch { /* ignore */ }
        }
        if (!res.headersSent) {
          res.status(500).json({ error: err instanceof Error ? err.message : "Upload failed" });
        }
      }
    })();
  });

  bb.on("error", (err: Error) => {
    logger.error({ err }, "Busboy upload error");
    if (!res.headersSent) {
      res.status(500).json({ error: String(err) });
    }
  });

  req.pipe(bb);
});

router.post("/clips/:id/retry", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetClipParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [clip] = await db
    .select()
    .from(clipsTable)
    .where(eq(clipsTable.id, params.data.id));

  if (!clip) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }

  if (clip.status !== "error") {
    res.status(400).json({ error: "Only clips in error state can be retried" });
    return;
  }

  // For local file clips, ensure the source file still exists
  if (clip.sourceType === "local" && clip.localFilePath && !fs.existsSync(clip.localFilePath)) {
    res.status(400).json({ error: "Original uploaded file no longer exists — please re-upload" });
    return;
  }

  const outputFilename = `clip_${clip.id}_${Date.now()}.mp4`;

  const [updated] = await db
    .update(clipsTable)
    .set({ status: "pending", progress: 0, errorMessage: null, outputFilename: null })
    .where(eq(clipsTable.id, clip.id))
    .returning();

  if (!updated) {
    res.status(500).json({ error: "Failed to reset clip" });
    return;
  }

  res.json(GetClipResponse.parse(updated));

  const clipMode = (clip.mode === "raw" ? "raw" : "edited") as "edited" | "raw";
  const youtubeUrl = clip.youtubeUrl ? normalizeYoutubeUrl(clip.youtubeUrl) : null;
  dispatchClipJob(
    clip.id,
    youtubeUrl,
    clip.startTime,
    clip.endTime,
    clip.headline,
    outputFilename,
    clipMode,
    clip.localFilePath ?? undefined
  );
});

router.get("/clips/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetClipParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [clip] = await db
    .select()
    .from(clipsTable)
    .where(eq(clipsTable.id, params.data.id));

  if (!clip) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }

  res.json(GetClipResponse.parse(clip));
});

router.get("/clips/:id/download", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetClipParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [clip] = await db
    .select()
    .from(clipsTable)
    .where(eq(clipsTable.id, params.data.id));

  if (!clip) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }

  if (clip.status !== "done" || !clip.outputFilename) {
    res.status(400).json({ error: "Clip is not ready for download" });
    return;
  }

  const filePath = getOutputFilePath(clip.outputFilename);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "Output file not found" });
    return;
  }

  res.download(filePath, clip.outputFilename);
});

router.delete("/clips/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteClipParams.safeParse({ id: raw });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [clip] = await db
    .delete(clipsTable)
    .where(eq(clipsTable.id, params.data.id))
    .returning();

  if (!clip) {
    res.status(404).json({ error: "Clip not found" });
    return;
  }

  // Delete processed output file
  if (clip.outputFilename) {
    const filePath = getOutputFilePath(clip.outputFilename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  // Delete uploaded source file for local clips
  if (clip.localFilePath && fs.existsSync(clip.localFilePath)) {
    try { fs.unlinkSync(clip.localFilePath); } catch { /* ignore */ }
  }

  res.sendStatus(204);
});

export default router;
