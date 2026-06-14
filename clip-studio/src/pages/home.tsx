import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useState, useRef, useCallback } from "react";
import {
  useListClips,
  useGetClipStats,
  getListClipsQueryKey,
  getGetClipStatsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ClipRow } from "@/components/clip-row";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2,
  Scissors,
  Activity,
  BarChart2,
  Plus,
  X,
  ChevronRight,
  Settings,
  Youtube,
  Upload,
  FileVideo,
} from "lucide-react";

const MAX_CLIPS = 10;
const MAX_FILE_BYTES = 20 * 1024 * 1024 * 1024;

const clipEntrySchema = z.object({
  mode: z.enum(["edited", "raw"]).default("edited"),
  startTime: z.string().regex(/^\d{2}:\d{2}:\d{2}$/, "Must be HH:MM:SS"),
  endTime: z.string().regex(/^\d{2}:\d{2}:\d{2}$/, "Must be HH:MM:SS"),
  headline: z.string().optional().default(""),
}).superRefine((val, ctx) => {
  if (val.mode === "edited" && (!val.headline || val.headline.trim().length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Headline required for Edited mode", path: ["headline"] });
  }
});

const formSchema = z.object({
  youtubeUrl: z
    .string()
    .url("Must be a valid URL")
    .regex(/youtube\.com|youtu\.be/, "Must be a YouTube URL"),
  clips: z.array(clipEntrySchema).min(1),
});

type FormValues = z.infer<typeof formSchema>;

const defaultClip = { mode: "edited" as const, startTime: "00:00:00", endTime: "00:00:15", headline: "" };

type SourceTab = "youtube" | "local";

interface LocalForm {
  startTime: string;
  endTime: string;
  headline: string;
  mode: "edited" | "raw";
}

export default function Home() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [sourceTab, setSourceTab] = useState<SourceTab>("youtube");

  // Local file upload state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [localForm, setLocalForm] = useState<LocalForm>({
    startTime: "00:00:00",
    endTime: "00:01:00",
    headline: "",
    mode: "edited",
  });
  const [localErrors, setLocalErrors] = useState<Partial<Record<keyof LocalForm | "file", string>>>({});

  const { data: clips, isLoading: isLoadingClips } = useListClips({
    query: { queryKey: getListClipsQueryKey() },
  });

  const { data: stats, isLoading: isLoadingStats } = useGetClipStats({
    query: { queryKey: getGetClipStatsQueryKey() },
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      youtubeUrl: "",
      clips: [{ ...defaultClip }],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "clips",
  });

  const [, navigate] = useLocation();
  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: FormValues) {
    let successCount = 0;
    const failReasons: string[] = [];

    for (const clip of values.clips) {
      try {
        const r = await fetch("/api/clips", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            youtubeUrl: values.youtubeUrl,
            startTime: clip.startTime,
            endTime: clip.endTime,
            headline: clip.headline ?? "",
            mode: clip.mode,
          }),
        });
        if (!r.ok) {
          let reason = "Failed";
          try { reason = ((await r.json()) as { error?: string }).error ?? reason; } catch { /* ignore */ }
          failReasons.push(reason);
        } else {
          successCount++;
        }
      } catch {
        failReasons.push("Network error");
      }
    }

    queryClient.invalidateQueries({ queryKey: getListClipsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetClipStatsQueryKey() });

    if (successCount > 0) {
      toast({
        title: successCount === 1 ? "1 clip job enqueued" : `${successCount} clip jobs enqueued`,
        description: failReasons.length > 0 ? `${failReasons.length} failed: ${failReasons[0]}` : undefined,
      });
      form.reset({ youtubeUrl: values.youtubeUrl, clips: [{ ...defaultClip }] });
    } else {
      toast({ title: "All submissions failed", description: failReasons[0], variant: "destructive" });
    }
  }

  const validateLocalForm = useCallback((): boolean => {
    const errors: typeof localErrors = {};
    if (!selectedFile) errors.file = "Please select a video file";
    if (!localForm.startTime.match(/^\d{2}:\d{2}:\d{2}$/)) errors.startTime = "Must be HH:MM:SS";
    if (!localForm.endTime.match(/^\d{2}:\d{2}:\d{2}$/)) errors.endTime = "Must be HH:MM:SS";
    if (localForm.mode === "edited" && !localForm.headline.trim()) errors.headline = "Headline required for Edited mode";
    setLocalErrors(errors);
    return Object.keys(errors).length === 0;
  }, [selectedFile, localForm]);

  const handleLocalUpload = useCallback(async () => {
    if (!validateLocalForm() || !selectedFile) return;

    setIsUploading(true);
    setUploadProgress(0);

    const formData = new FormData();
    formData.append("file", selectedFile);
    formData.append("startTime", localForm.startTime);
    formData.append("endTime", localForm.endTime);
    formData.append("headline", localForm.headline);
    formData.append("mode", localForm.mode);

    await new Promise<void>((resolve) => {
      const xhr = new XMLHttpRequest();

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          setUploadProgress(Math.round((e.loaded / e.total) * 100));
        }
      };

      xhr.onload = () => {
        setIsUploading(false);
        setUploadProgress(null);
        if (xhr.status === 201) {
          toast({ title: "File uploaded — processing started" });
          setSelectedFile(null);
          if (fileInputRef.current) fileInputRef.current.value = "";
          setLocalForm({ startTime: "00:00:00", endTime: "00:01:00", headline: "", mode: "edited" });
          setLocalErrors({});
          queryClient.invalidateQueries({ queryKey: getListClipsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetClipStatsQueryKey() });
        } else {
          let msg = "Upload failed";
          try { msg = (JSON.parse(xhr.responseText) as { error: string }).error || msg; } catch { /* ignore */ }
          toast({ title: msg, variant: "destructive" });
        }
        resolve();
      };

      xhr.onerror = () => {
        setIsUploading(false);
        setUploadProgress(null);
        toast({ title: "Network error — upload failed", variant: "destructive" });
        resolve();
      };

      xhr.open("POST", "/api/clips/upload");
      xhr.send(formData);
    });
  }, [selectedFile, localForm, validateLocalForm, queryClient, toast]);

  const clipCount = fields.length;

  return (
    <div className="h-full bg-background text-foreground flex flex-col font-sans selection:bg-primary selection:text-primary-foreground overflow-hidden">
      <header className="border-b border-border bg-card px-6 py-4 flex items-center gap-3 shrink-0">
        <div className="w-8 h-8 bg-primary rounded flex items-center justify-center text-primary-foreground">
          <Scissors className="w-5 h-5" strokeWidth={2.5} />
        </div>
        <div>
          <h1 className="font-bold tracking-tight leading-none">CLIP STUDIO</h1>
          <p className="text-[10px] uppercase font-mono text-muted-foreground tracking-wider">
            Viral Shorts Factory
          </p>
        </div>
        <button
          onClick={() => navigate("/settings")}
          className="ml-auto text-muted-foreground hover:text-foreground transition-colors"
          title="Settings"
        >
          <Settings className="w-4 h-4" />
        </button>
      </header>

      <main className="flex-1 flex flex-col min-h-0">
        {/* FORM */}
        <section className="flex-1 min-h-0 overflow-y-auto border-b border-border bg-background p-6 md:p-8">
          <div className="max-w-4xl mx-auto">
            <h2 className="text-sm font-mono text-muted-foreground uppercase tracking-widest mb-5 flex items-center gap-2">
              <Activity className="w-4 h-4" />
              New Job Definition
            </h2>

            {/* Source tab switcher */}
            <div className="flex mb-5 rounded-md overflow-hidden border border-border bg-card w-fit">
              <button
                type="button"
                onClick={() => setSourceTab("youtube")}
                className={`flex items-center gap-2 px-4 py-2 text-xs font-mono uppercase tracking-wider transition-colors ${
                  sourceTab === "youtube"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Youtube className="w-3.5 h-3.5" />
                YouTube
              </button>
              <button
                type="button"
                onClick={() => setSourceTab("local")}
                className={`flex items-center gap-2 px-4 py-2 text-xs font-mono uppercase tracking-wider transition-colors ${
                  sourceTab === "local"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Upload className="w-3.5 h-3.5" />
                Local File
              </button>
            </div>

            {/* ── YouTube tab ── */}
            {sourceTab === "youtube" && (
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
                <div className="space-y-1.5">
                  <Label className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
                    Source URL
                  </Label>
                  <Input
                    placeholder="https://youtube.com/watch?v=..."
                    className="font-mono text-sm bg-card"
                    {...form.register("youtubeUrl")}
                  />
                  {form.formState.errors.youtubeUrl && (
                    <p className="text-xs text-destructive font-mono">
                      {form.formState.errors.youtubeUrl.message}
                    </p>
                  )}
                </div>

                <div className="space-y-3">
                  <div className="grid grid-cols-12 gap-3 px-1">
                    <div className="col-span-1 flex items-center">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/50">#</span>
                    </div>
                    <div className="col-span-2">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Mode</span>
                    </div>
                    <div className="col-span-2">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">IN (HH:MM:SS)</span>
                    </div>
                    <div className="col-span-2">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">OUT (HH:MM:SS)</span>
                    </div>
                    <div className="col-span-4">
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Overlay Headline</span>
                    </div>
                    <div className="col-span-1" />
                  </div>

                  {fields.map((field, index) => {
                    const currentMode = form.watch(`clips.${index}.mode`);
                    const isRaw = currentMode === "raw";
                    return (
                      <div key={field.id} className="grid grid-cols-12 gap-3 items-start">
                        <div className="col-span-1 flex items-center h-10">
                          <span className="font-mono text-xs text-muted-foreground/40 tabular-nums">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                        </div>
                        <div className="col-span-2 flex h-10 rounded-md overflow-hidden border border-border bg-card text-[10px] font-mono uppercase tracking-wider">
                          <button type="button" onClick={() => form.setValue(`clips.${index}.mode`, "edited")}
                            className={`flex-1 flex items-center justify-center transition-colors ${!isRaw ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                            Edited
                          </button>
                          <button type="button" onClick={() => form.setValue(`clips.${index}.mode`, "raw")}
                            className={`flex-1 flex items-center justify-center transition-colors ${isRaw ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                            Raw
                          </button>
                        </div>
                        <div className="col-span-2">
                          <Input placeholder="00:00:00" className="font-mono text-sm bg-card h-10" {...form.register(`clips.${index}.startTime`)} />
                          {form.formState.errors.clips?.[index]?.startTime && (
                            <p className="text-[10px] text-destructive font-mono mt-0.5">{form.formState.errors.clips[index]!.startTime!.message}</p>
                          )}
                        </div>
                        <div className="col-span-2">
                          <Input placeholder="00:00:15" className="font-mono text-sm bg-card h-10" {...form.register(`clips.${index}.endTime`)} />
                          {form.formState.errors.clips?.[index]?.endTime && (
                            <p className="text-[10px] text-destructive font-mono mt-0.5">{form.formState.errors.clips[index]!.endTime!.message}</p>
                          )}
                        </div>
                        <div className="col-span-4">
                          {isRaw ? (
                            <div className="h-10 flex items-center px-3 rounded-md border border-dashed border-border/50 text-xs text-muted-foreground/40 font-mono italic select-none">
                              No overlay in raw mode
                            </div>
                          ) : (
                            <>
                              <Input placeholder="Wait till the end..." className="text-sm bg-card h-10" {...form.register(`clips.${index}.headline`)} />
                              {form.formState.errors.clips?.[index]?.headline && (
                                <p className="text-[10px] text-destructive font-mono mt-0.5">{form.formState.errors.clips[index]!.headline!.message}</p>
                              )}
                            </>
                          )}
                        </div>
                        <div className="col-span-1 flex items-center justify-center h-10">
                          {clipCount > 1 && (
                            <button type="button" onClick={() => remove(index)}
                              className="w-7 h-7 flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors">
                              <X className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {clipCount < MAX_CLIPS && (
                  <button type="button" onClick={() => append({ ...defaultClip })}
                    className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-muted-foreground hover:text-primary transition-colors py-1">
                    <Plus className="w-3.5 h-3.5" />
                    Add clip ({clipCount}/{MAX_CLIPS})
                  </button>
                )}
                {clipCount >= MAX_CLIPS && (
                  <p className="text-xs font-mono text-muted-foreground/50 uppercase tracking-wider">
                    Max {MAX_CLIPS} clips per batch reached
                  </p>
                )}

                <div className="flex justify-end pt-1">
                  <Button type="submit" disabled={isSubmitting} className="font-mono uppercase tracking-widest text-xs h-12 px-8">
                    {isSubmitting ? (
                      <><Loader2 className="mr-2 h-4 w-4 animate-spin" />DISPATCHING {clipCount} JOB{clipCount > 1 ? "S" : ""}...</>
                    ) : (
                      `ENQUEUE ${clipCount} JOB${clipCount > 1 ? "S" : ""}`
                    )}
                  </Button>
                </div>
              </form>
            )}

            {/* ── Local File tab ── */}
            {sourceTab === "local" && (
              <div className="space-y-5">
                {/* File picker */}
                <div className="space-y-1.5">
                  <Label className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
                    Video File <span className="text-muted-foreground/50">(max 20 GB)</span>
                  </Label>
                  <div
                    className={`relative flex items-center gap-3 rounded-md border bg-card px-4 py-3 cursor-pointer hover:bg-card/80 transition-colors ${localErrors.file ? "border-destructive" : "border-border"}`}
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const file = e.dataTransfer.files?.[0] ?? null;
                      if (!file) return;
                      if (file.size > MAX_FILE_BYTES) {
                        toast({ title: "File too large — max 20 GB", variant: "destructive" });
                        return;
                      }
                      setSelectedFile(file);
                      setLocalErrors((prev) => ({ ...prev, file: undefined }));
                    }}
                  >
                    <FileVideo className={`w-5 h-5 shrink-0 ${selectedFile ? "text-primary" : "text-muted-foreground/50"}`} />
                    <div className="flex-1 min-w-0">
                      {selectedFile ? (
                        <>
                          <p className="text-sm font-medium truncate">{selectedFile.name}</p>
                          <p className="text-[10px] font-mono text-muted-foreground">
                            {(selectedFile.size / (1024 * 1024)).toFixed(1)} MB
                          </p>
                        </>
                      ) : (
                        <p className="text-sm text-muted-foreground">Click to browse or drag a video file here</p>
                      )}
                    </div>
                    {selectedFile && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setSelectedFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}
                        className="shrink-0 w-6 h-6 flex items-center justify-center rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="video/*,.mp4,.mkv,.mov,.avi,.webm,.m4v,.wmv,.flv,.ts,.mts"
                      className="sr-only"
                      onChange={(e) => {
                        const file = e.target.files?.[0] ?? null;
                        if (file && file.size > MAX_FILE_BYTES) {
                          toast({ title: "File too large — max 20 GB", variant: "destructive" });
                          return;
                        }
                        setSelectedFile(file);
                        setLocalErrors((prev) => ({ ...prev, file: undefined }));
                      }}
                    />
                  </div>
                  {localErrors.file && <p className="text-xs text-destructive font-mono">{localErrors.file}</p>}
                </div>

                {/* Times + Mode */}
                <div className="grid grid-cols-12 gap-3">
                  {/* Mode toggle */}
                  <div className="col-span-12 md:col-span-3">
                    <Label className="font-mono text-xs uppercase tracking-wider text-muted-foreground mb-1.5 block">Mode</Label>
                    <div className="flex h-10 rounded-md overflow-hidden border border-border bg-card text-[10px] font-mono uppercase tracking-wider">
                      <button type="button" onClick={() => setLocalForm((f) => ({ ...f, mode: "edited" }))}
                        className={`flex-1 flex items-center justify-center transition-colors ${localForm.mode === "edited" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                        Edited
                      </button>
                      <button type="button" onClick={() => setLocalForm((f) => ({ ...f, mode: "raw" }))}
                        className={`flex-1 flex items-center justify-center transition-colors ${localForm.mode === "raw" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
                        Raw
                      </button>
                    </div>
                  </div>

                  {/* Start time */}
                  <div className="col-span-6 md:col-span-3">
                    <Label className="font-mono text-xs uppercase tracking-wider text-muted-foreground mb-1.5 block">IN (HH:MM:SS)</Label>
                    <Input
                      placeholder="00:00:00"
                      className={`font-mono text-sm bg-card h-10 ${localErrors.startTime ? "border-destructive" : ""}`}
                      value={localForm.startTime}
                      onChange={(e) => setLocalForm((f) => ({ ...f, startTime: e.target.value }))}
                    />
                    {localErrors.startTime && <p className="text-[10px] text-destructive font-mono mt-0.5">{localErrors.startTime}</p>}
                  </div>

                  {/* End time */}
                  <div className="col-span-6 md:col-span-3">
                    <Label className="font-mono text-xs uppercase tracking-wider text-muted-foreground mb-1.5 block">OUT (HH:MM:SS)</Label>
                    <Input
                      placeholder="00:01:00"
                      className={`font-mono text-sm bg-card h-10 ${localErrors.endTime ? "border-destructive" : ""}`}
                      value={localForm.endTime}
                      onChange={(e) => setLocalForm((f) => ({ ...f, endTime: e.target.value }))}
                    />
                    {localErrors.endTime && <p className="text-[10px] text-destructive font-mono mt-0.5">{localErrors.endTime}</p>}
                  </div>
                </div>

                {/* Headline */}
                {localForm.mode === "edited" && (
                  <div className="space-y-1.5">
                    <Label className="font-mono text-xs uppercase tracking-wider text-muted-foreground">Overlay Headline</Label>
                    <Input
                      placeholder="Wait till the end..."
                      className={`text-sm bg-card ${localErrors.headline ? "border-destructive" : ""}`}
                      value={localForm.headline}
                      onChange={(e) => setLocalForm((f) => ({ ...f, headline: e.target.value }))}
                    />
                    {localErrors.headline && <p className="text-xs text-destructive font-mono">{localErrors.headline}</p>}
                  </div>
                )}

                {/* Upload progress */}
                {isUploading && uploadProgress !== null && (
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-mono text-muted-foreground">Uploading…</span>
                      <span className="text-[10px] font-mono text-primary font-semibold">{uploadProgress}%</span>
                    </div>
                    <div className="h-1 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full transition-all duration-300"
                        style={{ width: `${uploadProgress}%` }}
                      />
                    </div>
                  </div>
                )}

                <div className="flex justify-end pt-1">
                  <Button
                    type="button"
                    disabled={isUploading}
                    onClick={handleLocalUpload}
                    className="font-mono uppercase tracking-widest text-xs h-12 px-8"
                  >
                    {isUploading ? (
                      <><Loader2 className="mr-2 h-4 w-4 animate-spin" />UPLOADING…</>
                    ) : (
                      <><Upload className="mr-2 h-4 w-4" />UPLOAD &amp; PROCESS</>
                    )}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* TIMELINE NAV */}
        <button
          type="button"
          onClick={() => navigate("/timeline")}
          className="shrink-0 border-t border-border bg-card px-6 py-3 flex items-center justify-between w-full hover:bg-card/80 transition-colors"
        >
          <div className="flex items-center gap-2 text-sm font-mono text-muted-foreground uppercase tracking-widest">
            <BarChart2 className="w-4 h-4" />
            Timeline
          </div>
          <div className="flex items-center gap-4 text-xs font-mono">
            {!isLoadingStats && stats ? (
              <>
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground">TOTAL:</span>
                  <span className="text-foreground">{stats.total}</span>
                </div>
                <div className="w-px h-3 bg-border" />
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground">PROCESSING:</span>
                  <span className="text-primary">{stats.processing + stats.pending}</span>
                </div>
                <div className="w-px h-3 bg-border" />
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground">DONE:</span>
                  <span className="text-green-500">{stats.done}</span>
                </div>
                <div className="w-px h-3 bg-border" />
                <div className="flex items-center gap-1.5">
                  <span className="text-muted-foreground">ERROR:</span>
                  <span className="text-destructive">{stats.error}</span>
                </div>
                <div className="w-px h-3 bg-border" />
              </>
            ) : null}
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          </div>
        </button>
      </main>
    </div>
  );
}
