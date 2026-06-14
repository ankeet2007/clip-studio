import { Router } from "express";
import { getAiClipSuggestion } from "../lib/aiHelper";
import { YoutubeTranscript } from "youtube-transcript";

const aiRouter = Router();

aiRouter.post("/ai-suggest", async (req, res) => {
  const { youtubeUrl } = req.body;
  
  if (!youtubeUrl) {
    res.status(400).send({ error: "YouTube URL is required" });
    return;
  }

  try {
    // Attempt to extract the ID manually if the package fails
    const videoIdMatch = youtubeUrl.match(/(?:youtu\.be\/|youtube\.com\/(?:live\/|embed\/|v\/|watch\?v=))([^&?]+)/);
    const videoId = videoIdMatch ? videoIdMatch[1] : youtubeUrl;

    // Fetch the transcript using the ID
    const transcriptItems = await YoutubeTranscript.fetchTranscript(videoId);
    
    // Combine text
    const fullTranscript = transcriptItems.map(item => item.text).join(" ");

    // Send to Gemini
    const suggestion = await getAiClipSuggestion(fullTranscript);
    res.send(suggestion); 
  } catch (error) {
    console.error("Transcript/AI Error:", error);
    res.status(500).send({ error: "Failed to fetch transcript. Note: Live streams might not have captions enabled." });
  }
});

export default aiRouter;
