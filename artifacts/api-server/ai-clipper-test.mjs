import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function run() {
  // Using the free flash model
  const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite" });
  
  // A fake 20-second podcast transcript
  const transcript = `
  00:01 - Host: So, how did you make your first million?
  00:04 - Guest: Honestly? I was broke, sleeping in my car. I just had a cheap tablet and free McDonald's WiFi.
  00:11 - Host: No way, really?
  00:13 - Guest: Yeah, and I coded a tiny clipping app in 3 days that ended up going totally viral.
  00:18 - Host: That is absolutely insane.
  `;

  const prompt = `
  You are an expert short-form video editor for TikTok and YouTube Shorts. 
  Read this transcript and find the most viral, hook-worthy segment. 
  Give me the best Start Time, End Time, and a short 4-word "Overlay Headline" to print on the video.
  
  Transcript:
  ${transcript}
  `;
  
  console.log("AI is watching the video and thinking...");
  const result = await model.generateContent(prompt);
  
  console.log("\n--- AI CLIP SUGGESTION ---");
  console.log(result.response.text());
}

run();

