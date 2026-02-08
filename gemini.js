import { GoogleGenerativeAI } from "@google/generative-ai";
import { db } from "./firebase-admin.js";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is missing in environment variables");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Stable production model with good free tier quotas
const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 2000  // Increased to prevent truncation
    }
});

/**
 * Increment API request counter for user and log the request
 * Tracks: total count, logs (last 100), byDate, byType
 */
async function incrementAPICount(userId, operation = 'unknown', details = '') {
    if (!userId) return;
    
    try {
        const userRef = db.collection("users").doc(userId);
        const userDoc = await userRef.get();
        const userData = userDoc.data() || {};
        
        const currentCount = userData.apiRequestCount || 0;
        const currentLogs = userData.apiLogs || [];
        const byDate = userData.apiUsage?.byDate || {};
        const byType = userData.apiUsage?.byType || {};
        
        const today = new Date().toISOString().split('T')[0];
        const operationType = operation.includes('text') ? 'text' : 
                              operation.includes('voice') ? 'voice' : 
                              operation.includes('weekly') ? 'weekly' : 'other';
        
        const newLog = {
            timestamp: Date.now(),
            operation,
            details
        };
        
        // Keep only last 100 logs to prevent document bloat
        const updatedLogs = [...currentLogs.slice(-99), newLog];
        
        await userRef.set({
            apiRequestCount: currentCount + 1,
            apiLogs: updatedLogs,
            apiUsage: {
                byDate: { ...byDate, [today]: (byDate[today] || 0) + 1 },
                byType: { ...byType, [operationType]: (byType[operationType] || 0) + 1 },
                lastUpdated: Date.now()
            }
        }, { merge: true });
        
        console.log(`📊 API Count: ${currentCount + 1} | Operation: ${operation} | Type: ${operationType}`);
    } catch (err) {
        console.error("Failed to increment API count:", err.message);
    }
}

/**
 * Safe Gemini call wrapper with robust JSON extraction
 */
async function callGemini(prompt, userId = null, operation = 'unknown', details = '') {
    // Increment API counter if userId provided
    if (userId) {
        await incrementAPICount(userId, operation, details);
    }
    
    const result = await model.generateContent(prompt);
    const text = result.response.text();

    console.log("RAW GEMINI RESPONSE:\n", text);

    let jsonStr = text.trim();

    // Step 1: Remove ALL backticks (markdown code blocks)
    jsonStr = jsonStr.replace(/```json/g, '').replace(/```/g, '').trim();

    // Step 2: Extract the JSON object (from first { to last })
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
    }

    try {
        const parsed = JSON.parse(jsonStr);
        console.log("✅ Successfully parsed JSON:", parsed);
        return parsed;
    } catch (err) {
        console.error("❌ JSON PARSE ERROR:");
        console.error("Raw text:", text);
        console.error("Cleaned string:", jsonStr);
        console.error("Parse error:", err.message);
        
        // If JSON is incomplete, throw a more specific error
        if (err.message.includes('Unterminated') || err.message.includes('Unexpected end')) {
            throw new Error("Gemini response was incomplete - try again");
        }
        throw new Error("Invalid AI response format - could not parse JSON");
    }
}

/**
 * DAILY TEXT ANALYSIS
 */
export async function analyzeTextReflection(textInput, userId = null) {
    const prompt = `You are an emotional reflection and journaling AI for MindMirror.

Analyze the following transcript and return ONLY a valid JSON object (no markdown, no code blocks, no explanations).

Transcript:
"${textInput}"

IMPORTANT: Return ONLY the JSON object below, nothing else. Do NOT wrap it in markdown code blocks.

{
  "transcript": "${textInput}",
  "dailyInsight": "string (2–3 reflective sentences)",
  "primaryEmotion": "string",
  "secondaryEmotion": "string",
  "emotionalIntensity": "low | medium | high",
  "theme": "self | relationships | work | growth | health"
}`;

    try {
        const data = await callGemini(prompt, userId, 'text-analysis', 'Daily text reflection');
        return { success: true, data };
    } catch (error) {
        console.error("TEXT ANALYSIS ERROR:", error.message);
        return { success: false, error: error.message };
    }
}

/**
 * BACKGROUND TRANSCRIPT ANALYSIS
 * Analyzes transcript and updates Firebase document asynchronously
 */
export async function analyzeTranscriptBackground(userId, docId, transcript) {
    console.log(`[BACKGROUND ANALYSIS] Starting for user=${userId}, doc=${docId}`);
    
    try {
        const prompt = `You are an emotional reflection and journaling AI for MindMirror.

Analyze the following transcript and return ONLY a valid JSON object (no markdown, no code blocks, no explanations).

Transcript:
"${transcript}"

IMPORTANT: Return ONLY the JSON object below, nothing else. Do NOT wrap it in markdown code blocks.

{
  "dailyInsight": "string (2–3 reflective sentences)",
  "primaryEmotion": "string",
  "secondaryEmotion": "string",
  "emotionalIntensity": "low | medium | high",
  "theme": "self | relationships | work | growth | health"
}`;

        const data = await callGemini(prompt, userId, 'voice-analysis', 'Voice transcript analysis');
        
        // Update Firebase document with analysis
        const docRef = db.collection("users").doc(userId).collection("reflections").doc(docId);
        
        await docRef.update({
            dailyInsight: data.dailyInsight,
            primaryEmotion: data.primaryEmotion,
            secondaryEmotion: data.secondaryEmotion,
            emotionalIntensity: data.emotionalIntensity,
            theme: data.theme,
            analysisStatus: "completed"
        });

        console.log(`[BACKGROUND ANALYSIS] ✅ Completed for doc=${docId}`);
        return { success: true, data };
    } catch (error) {
        console.error(`[BACKGROUND ANALYSIS] ❌ Failed for doc=${docId}:`, error.message);
        
        // Update status to failed in Firebase
        try {
            const docRef = db.collection("users").doc(userId).collection("reflections").doc(docId);
            await docRef.update({
                analysisStatus: "failed",
                analysisError: error.message
            });
        } catch (updateError) {
            console.error("[BACKGROUND ANALYSIS] Failed to update error status:", updateError);
        }
        
        return { success: false, error: error.message };
    }
}

/**
 * WEEKLY PATTERN ANALYSIS
 */
export async function analyzeWeeklyPatterns(reflections, userId = null) {
    if (!reflections || reflections.length < 3) {
        return {
            success: false,
            error: "Not enough reflections for weekly analysis"
        };
    }

    const summary = reflections.map(r => ({
        date: r.date,
        primaryEmotion: r.primaryEmotion,
        secondaryEmotion: r.secondaryEmotion,
        theme: r.theme,
        emotionalIntensity: r.emotionalIntensity
    }));

    const prompt = `
You are an emotional pattern analyst for MindMirror.

Analyze the following reflections and respond ONLY with valid JSON:

${JSON.stringify(summary, null, 2)}

Return EXACTLY:
{
  "dominantEmotions": ["emotion1", "emotion2"],
  "dominantThemes": ["theme1", "theme2"],
  "emotionalPattern": "brief description of patterns noticed",
  "weeklyInsight": "2–3 sentence reflective observation",
  "reflectiveQuestion": "one open-ended question"
}

Rules:
- Descriptive only
- No advice
- No diagnosis
- Gentle, neutral tone
`;

    try {
        const data = await callGemini(prompt, userId, 'weekly-analysis', 'Weekly pattern analysis');
        return { success: true, data };
    } catch (error) {
        console.error("WEEKLY ANALYSIS ERROR:", error.message);
        return { success: false, error: error.message };
    }
}
