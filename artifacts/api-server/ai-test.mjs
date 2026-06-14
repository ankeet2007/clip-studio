import { GoogleGenerativeAI } from "@google/generative-ai";

// This pulls the key from your Termux environment
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function run() {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  
  const prompt = "I just built an auto-clipper app in Termux on my tablet. Give me a 3-word catchphrase for it!";
  
  console.log("Connecting to Gemini...");
  const result = await model.generateContent(prompt);
  console.log("\nSuccess! Gemini says:");
  console.log(result.response.text());
}

run();

