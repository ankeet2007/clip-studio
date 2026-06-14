import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");

export async function getAiClipSuggestion(transcript: string) {
  const model = genAI.getGenerativeModel({ model: "gemini-3.1-flash-lite" });

  const prompt = `
  You are an expert short-form video editor. 
  Read this transcript and find the most viral, hook-worthy segment. 
  Return ONLY a valid JSON object in this exact format, with no extra text or formatting:
  {
    "inTime": "00:00:00",
    "outTime": "00:00:15",
    "headline": "A catchy 4-word title"
  }

  Transcript:
  ${transcript}
  `;

  try {
    const result = await model.generateContent(prompt);
    const cleanText = result.response.text()
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim();
    return JSON.parse(cleanText);
  } catch (error) {
    console.error("AI Generation Failed:", error);
    throw new Error("Failed to generate AI suggestion");
  }
}
