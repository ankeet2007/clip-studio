import { useParams, useLocation } from "wouter";
import { useGetClip, getGetClipQueryKey, getListClipsQueryKey, getGetClipStatsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  Download,
  RefreshCw,
  Clock,
  Loader2,
  CheckCircle,
  AlertTriangle,
  Scissors,
  PlayCircle,
  Link,
} from "lucide-react";
import { useEffect, useRef } from "react";

export default function ClipDetail() {
  const params = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const clipId = Number(params.id);

  const { data: clip, isLoading, isError } = useGetClip(clipId, {
    query: {
      queryKey: getGetClipQueryKey(clipId),
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return status === "pending" || status === "processing" ? 3000 : false;
      },
    },
  });

  const prevStatus = useRef(clip?.status);
  useEffect(() => {
    if (prevStatus.current !== clip?.status && (clip?.status === "done" || clip?.status === "error")) {
      prevStatus.current = clip.status;
      queryClient.invalidateQueries({ queryKey: getListClipsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetClipStatsQueryKey() });
    }
  }, [clip?.status, queryClient]);

  async function handleRetry() {
    try {
      const res = await fetch(`/api/clips/${clipId}/retry`, { method: "POST" });
      if (!res.ok) throw new Error("Retry failed");
      queryClient.invalidateQueries({ queryKey: getGetClipQueryKey(clipId) });
      queryClient.invalidateQueries({ queryKey: getListClipsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetClipStatsQueryKey() });
      toast({ title: "Clip re-queued" });
    } catch {
      toast({ title: "Failed to retry clip", variant: "destructive" });
    }
  }

  const getStatusBadge = () => {
    switch (clip?.status) {
      case "pending":
        return (
          <Badge variant="secondary" className="flex items-center gap-1.5 font-mono uppercase text-xs">
            <Clock className="w-3.5 h-3.5" /> Queued
          </Badge>
        );
      case "processing":
        return (
          <Badge className="bg-primary text-primary-foreground flex items-center gap-1.5 font-mono uppercase text-xs">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Processing
          </Badge>
        );
      case "done":
        return (
          <Badge className="bg-green-500/10 text-green-500 border border-green-500/20 flex items-center gap-1.5 font-mono uppercase text-xs">
            <CheckCircle className="w-3.5 h-3.5" /> Done
          </Badge>
        );
      case "error":
        return (
          <Badge variant="destructive" className="flex items-center gap-1.5 font-mono uppercase text-xs">
            <AlertTriangle className="w-3.5 h-3.5" /> Error
          </Badge>
        );
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans">
      {/* Header */}
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
      </header>

      <main className="flex-1 p-6 md:p-8 max-w-3xl mx-auto w-full">
        {/* Back button */}
        <button
          onClick={() => navigate("/timeline")}
          className="flex items-center gap-2 text-sm font-mono text-muted-foreground hover:text-foreground transition-colors mb-8 group"
        >
          <ArrowLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" />
          Back to Timeline
        </button>

        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-8 w-64 bg-muted" />
            <Skeleton className="h-4 w-48 bg-muted" />
            <Skeleton className="h-32 w-full bg-muted rounded-lg" />
          </div>
        ) : isError || !clip ? (
          <div className="text-center py-16 text-muted-foreground">
            <p className="font-mono text-sm uppercase tracking-widest">Clip not found</p>
            <Button variant="ghost" className="mt-4" onClick={() => navigate("/")}>
              Go back
            </Button>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Title row */}
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 mb-2 flex-wrap">
                  {getStatusBadge()}
                  <span className="font-mono text-xs text-muted-foreground">#{clip.id}</span>
                </div>
                <h2 className="text-2xl font-bold tracking-tight truncate">{clip.headline}</h2>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 shrink-0">
                {clip.status === "done" && clip.outputFilename && (
                  <Button
                    className="font-mono text-xs bg-green-600 hover:bg-green-500 text-white"
                    asChild
                  >
                    <a href={`/api/clips/${clip.id}/download`} download>
                      <Download className="w-4 h-4 mr-2" />
                      Download
                    </a>
                  </Button>
                )}
                {clip.status === "error" && (
                  <Button
                    variant="outline"
                    className="font-mono text-xs border-destructive/50 text-destructive hover:bg-destructive hover:text-white"
                    onClick={handleRetry}
                  >
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Retry
                  </Button>
                )}
              </div>
            </div>

            {/* Details card */}
            <div className="rounded-lg border border-border bg-card p-5 space-y-4">
              <div className="space-y-3">
                <div className="flex items-start gap-3">
                  <Link className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-0.5">Source URL</p>
                    <p className="text-sm font-mono break-all">{clip.youtubeUrl}</p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <PlayCircle className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                  <div>
                    <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-0.5">Timestamps</p>
                    <p className="text-sm font-mono">{clip.startTime} &ndash; {clip.endTime}</p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <Clock className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                  <div>
                    <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mb-0.5">Created</p>
                    <p className="text-sm font-mono">
                      {new Date(clip.createdAt).toLocaleString()}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Processing indicator */}
            {(clip.status === "pending" || clip.status === "processing") && (
              <div className="flex items-center gap-3 rounded-lg border border-primary/20 bg-primary/5 px-5 py-4">
                <Loader2 className="w-5 h-5 animate-spin text-primary shrink-0" />
                <div>
                  <p className="text-sm font-semibold">
                    {clip.status === "pending" ? "Waiting in queue…" : "Processing your clip…"}
                  </p>
                  <p className="text-xs text-muted-foreground font-mono mt-0.5">
                    This page will update automatically
                  </p>
                </div>
              </div>
            )}

            {/* Error message */}
            {clip.status === "error" && clip.errorMessage && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4">
                <p className="text-xs font-mono text-destructive uppercase tracking-wider mb-2">Error Details</p>
                <p className="text-sm text-destructive/90 font-mono break-words">{clip.errorMessage}</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4 font-mono text-xs border-destructive/50 text-destructive hover:bg-destructive hover:text-white"
                  onClick={handleRetry}
                >
                  <RefreshCw className="w-3.5 h-3.5 mr-2" />
                  Retry this clip
                </Button>
              </div>
            )}

            {/* Done — ready */}
            {clip.status === "done" && (
              <div className="flex items-center gap-3 rounded-lg border border-green-500/20 bg-green-500/5 px-5 py-4">
                <CheckCircle className="w-5 h-5 text-green-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-green-400">Clip is ready</p>
                  <p className="text-xs text-muted-foreground font-mono mt-0.5 truncate">
                    {clip.outputFilename}
                  </p>
                </div>
                {clip.outputFilename && (
                  <Button
                    size="sm"
                    className="font-mono text-xs bg-green-600 hover:bg-green-500 text-white shrink-0"
                    asChild
                  >
                    <a href={`/api/clips/${clip.id}/download`} download>
                      <Download className="w-4 h-4 mr-2" />
                      Download
                    </a>
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
