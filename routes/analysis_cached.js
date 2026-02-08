import express from "express";
import { analyzeTextReflection, analyzeTranscriptBackground, analyzeWeeklyPatterns } from "../gemini.js";
import { db } from "../firebase-admin.js";

const router = express.Router();

/**
 * POST /api/save-transcript
 * FAST endpoint - saves transcript immediately and triggers analysis in background
 */
router.post("/save-transcript", async (req, res) => {
    try {
        const { userId, userName, userEmail, date, transcript } = req.body;

        console.log("SAVE TRANSCRIPT REQ BODY:", req.body);

        if (!userId || !transcript) {
            return res.status(400).json({
                success: false,
                error: "userId and transcript are required"
            });
        }

        const dateStr = date || new Date().toISOString().split("T")[0];

        // Create readable document ID from date and time
        const now = new Date();
        const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-'); // HH-MM-SS
        const docId = `${dateStr}_${timeStr}`; // e.g., "2026-01-18_11-30-45"

        // Initial data with pending status
        const reflectionData = {
            date: dateStr,
            transcript: transcript.trim(),
            createdAt: now,
            analysisStatus: "pending",
            inputType: "voice" // Track input method
        };

        // Store in users/{userId}/reflections/{date-time}
        const userRef = db.collection("users").doc(userId);
        
        // Ensure user document exists with name and email
        await userRef.set({
            name: userName || 'Anonymous',
            email: userEmail || '',
            lastActive: now
        }, { merge: true });

        // Save transcript to Firebase
        await userRef.collection("reflections").doc(docId).set(reflectionData);

        console.log(`✅ Transcript saved: ${docId}`);

        // Trigger background analysis (non-blocking)
        analyzeTranscriptBackground(userId, docId, transcript.trim())
            .then(result => {
                if (result.success) {
                    console.log(`✨ Analysis completed for ${docId}`);
                    // Invalidate weekly cache when new reflection is analyzed
                    userRef.set({ weeklyAnalysisCache: null }, { merge: true });
                } else {
                    console.error(`❌ Analysis failed for ${docId}:`, result.error);
                }
            })
            .catch(err => {
                console.error(`❌ Background analysis error for ${docId}:`, err);
            });

        // Return immediately (don't wait for analysis)
        return res.json({
            success: true,
            reflection: {
                id: docId,
                userId,
                ...reflectionData
            }
        });
    } catch (error) {
        console.error("SAVE TRANSCRIPT ROUTE ERROR:", error);
        res.status(500).json({
            success: false,
            error: "Failed to save transcript"
        });
    }
});

/**
 * POST /api/analyze-daily
 * Text-based reflection analysis
 */
router.post("/analyze-daily", async (req, res) => {
    try {
        const { userId, userName, userEmail, date, textInput } = req.body;

        console.log("REQ BODY:", req.body);

        if (!userId || !textInput) {
            return res.status(400).json({
                success: false,
                error: "User ID and text input are required"
            });
        }

        const analysis = await analyzeTextReflection(textInput);

        if (!analysis.success) {
            return res.status(500).json({
                success: false,
                error: analysis.error
            });
        }

        const dateStr = date || new Date().toISOString().split("T")[0];
        const now = new Date();
        const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-');
        const docId = `${dateStr}_${timeStr}`;

        const reflectionData = {
            date: dateStr,
            transcript: analysis.data.transcript,
            primaryEmotion: analysis.data.primaryEmotion,
            secondaryEmotion: analysis.data.secondaryEmotion,
            theme: analysis.data.theme,
            emotionalIntensity: analysis.data.emotionalIntensity,
            dailyInsight: analysis.data.dailyInsight,
            createdAt: now,
            inputType: "text" // Track input method
        };

        // Store in users/{userId}/reflections/{date-time}
        const userRef = db.collection("users").doc(userId);
        
        // Ensure user document exists with name and email
        await userRef.set({
            name: userName || 'Anonymous',
            email: userEmail || '',
            lastActive: now
        }, { merge: true });

        await userRef.collection("reflections").doc(docId).set(reflectionData);

        // Invalidate weekly cache when new reflection is added
        await userRef.set({ weeklyAnalysisCache: null }, { merge: true });

        return res.json({
            success: true,
            analysis: {
                id: docId,
                userId,
                ...reflectionData
            }
        });
    } catch (error) {
        console.error("DAILY ANALYSIS ROUTE ERROR:", error);
        res.status(500).json({
            success: false,
            error: "Failed to analyze reflection"
        });
    }
});

/**
 * POST /api/analyze-weekly
 * WITH CACHING - Only calls Gemini if cache is stale (>24 hours old)
 */
router.post("/analyze-weekly", async (req, res) => {
    try {
        const { userId } = req.body;

        if (!userId) {
            return res.status(400).json({
                success: false,
                error: "User ID is required"
            });
        }

        const userRef = db.collection("users").doc(userId);

        // Check for cached weekly analysis
        const userDoc = await userRef.get();
        const userData = userDoc.data();
        
        if (userData?.weeklyAnalysisCache) {
            const cacheAge = Date.now() - userData.weeklyAnalysisCache.timestamp;
            const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in ms

            // Return cached data if less than 24 hours old
            if (cacheAge < CACHE_DURATION) {
                console.log(`✅ Returning cached weekly analysis (${Math.floor(cacheAge / 1000 / 60)} minutes old)`);
                return res.json({
                    success: true,
                    hasEnoughData: true,
                    reflectionCount: userData.weeklyAnalysisCache.reflectionCount,
                    analysis: userData.weeklyAnalysisCache.analysis,
                    cached: true
                });
            }
        }

        // Cache miss or stale - fetch fresh data
        console.log("🔄 Cache miss or stale, generating new weekly analysis");

        // Fetch from users/{userId}/reflections subcollection
        const snapshot = await db
            .collection("users")
            .doc(userId)
            .collection("reflections")
            .orderBy("createdAt", "desc")
            .limit(7)
            .get();

        if (snapshot.empty) {
            return res.json({
                success: true,
                hasEnoughData: false,
                message: "Not enough reflections"
            });
        }

        const reflections = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        if (reflections.length < 3) {
            return res.json({
                success: true,
                hasEnoughData: false,
                reflectionCount: reflections.length
            });
        }

        const analysis = await analyzeWeeklyPatterns(reflections);

        if (!analysis.success) {
            return res.status(500).json({
                success: false,
                error: analysis.error
            });
        }

        // Store in cache for future requests
        await userRef.set({
            weeklyAnalysisCache: {
                timestamp: Date.now(),
                reflectionCount: reflections.length,
                analysis: analysis.data
            }
        }, { merge: true });

        console.log("💾 Cached new weekly analysis");

        return res.json({
            success: true,
            hasEnoughData: true,
            reflectionCount: reflections.length,
            analysis: analysis.data,
            cached: false
        });
    } catch (error) {
        console.error("WEEKLY ANALYSIS ROUTE ERROR:", error);
        res.status(500).json({
            success: false,
            error: "Weekly analysis failed"
        });
    }
});

// ... rest of routes remain the same

export default router;
