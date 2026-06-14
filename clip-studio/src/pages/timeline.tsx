import { useLocation } from "wouter";
import {
  useListClips,
  useGetClipStats,
  getListClipsQueryKey,
  getGetClipStatsQueryKey,
} from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { ClipRow } from "@/components/clip-row";
import { ArrowLeft, BarChart2, Scissors } from "lucide-react";

export default function Timeline() {
  const [, navigate] = useLocation();

  const { data: clips, isLoading: isLoadingClips } = useListClips({
    query: { queryKey: getListClipsQueryKey(), refetchInterval: 5000 },
  });

  const { data: stats, isLoading: isLoadingStats } = useGetClipStats({
    query: { queryKey: getGetClipStatsQueryKey(), refetchInterval: 5000 },
  });

  return (
    <div className="h-full bg-background text-foreground flex flex-col font-sans overflow-hidden">
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

      {/* Sub-header */}
      <div className="shrink-0 border-b border-border bg-card px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate("/")}
            className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors group"
          >
            <ArrowLeft className="w-4 h-4 group-hover:-translate-x-0.5 transition-transform" />
          </button>
          <div className="flex items-center gap-2 text-sm font-mono text-muted-foreground uppercase tracking-widest">
            <BarChart2 className="w-4 h-4" />
            Timeline
          </div>
        </div>

        <div className="flex items-center gap-4 text-xs font-mono">
          {isLoadingStats ? (
            <Skeleton className="h-4 w-64 bg-muted" />
          ) : stats ? (
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
            </>
          ) : null}
        </div>
      </div>

      {/* Job list */}
      <main className="flex-1 min-h-0 overflow-y-auto p-4 md:p-6 bg-muted/20">
        <div className="max-w-4xl mx-auto border border-border bg-card rounded-md shadow-sm overflow-hidden">
          {isLoadingClips ? (
            <div className="p-8 space-y-4">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-16 w-full bg-muted/50 rounded" />
              ))}
            </div>
          ) : clips && clips.length > 0 ? (
            <div className="divide-y divide-border flex flex-col">
              {clips.map((clip) => (
                <ClipRow key={clip.id} initialClip={clip} />
              ))}
            </div>
          ) : (
            <div className="p-16 text-center flex flex-col items-center justify-center text-muted-foreground">
              <div className="w-12 h-12 border-2 border-dashed border-border rounded-full flex items-center justify-center mb-4">
                <Scissors className="w-5 h-5 text-border" />
              </div>
              <p className="font-mono text-sm uppercase tracking-widest">
                No jobs in timeline
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
