import express from "express";
import { db } from "../firebase-admin.js";
import { analyzeTextReflection, analyzeWeeklyPatterns, analyzeTranscriptBackground } from "../gemini.js";

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
                    // Invalidate weekly cache
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
 * TEXT-ONLY daily analysis (audio disabled for stability)
 */
router.post("/analyze-daily", async (req, res) => {
    try {
        const { userId, userName, userEmail, date, textInput } = req.body;

        console.log("REQ BODY:", req.body);

        if (!userId || !textInput) {
            return res.status(400).json({
                success: false,
                error: "userId and textInput are required"
            });
        }

        const dateStr = date || new Date().toISOString().split("T")[0];

        const analysis = await analyzeTextReflection(textInput, userId);

        if (!analysis.success) {
            return res.status(500).json({
                success: false,
                error: analysis.error
            });
        }

        // Create readable document ID from date and time
        const now = new Date();
        const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-'); // HH-MM-SS
        const docId = `${dateStr}_${timeStr}`; // e.g., "2026-01-16_21-30-45"

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

        // Invalidate weekly cache when new reflection added
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

        //CHECK CACHE - Return if fresh (less than 24 hours old)
        const userDoc = await userRef.get();
        const userData = userDoc.data();
        
        if (userData?.weeklyAnalysisCache) {
            const cacheAge = Date.now() - userData.weeklyAnalysisCache.timestamp;
            const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

            if (cacheAge < CACHE_DURATION) {
                console.log(`✅ Cached weekly (${Math.floor(cacheAge/60000)} min old)`);
                return res.json({
                    success: true,
                    hasEnoughData: true,
                    reflectionCount: userData.weeklyAnalysisCache.reflectionCount,
                    analysis: userData.weeklyAnalysisCache.analysis
                });
            }
        }

        console.log("🔄 Generating fresh weekly analysis");

        // Fetch from users/{userId}/reflections subcollection
        const snapshot = await userRef
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

        // Try analysis with timeout, fallback to synthetic if it fails
        let analysis;
        const GEMINI_TIMEOUT = 15000; // 15 seconds max
        
        try {
            // Create a promise that rejects after timeout
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Gemini timeout')), GEMINI_TIMEOUT)
            );
            
            // Race between actual analysis and timeout
            analysis = await Promise.race([
                analyzeWeeklyPatterns(reflections, userId),
                timeoutPromise
            ]);
        } catch (timeoutErr) {
            console.log("⚠️ Gemini timeout - generating synthetic analysis");
            
            // Generate synthetic fallback from reflection data
            const emotions = reflections
                .map(r => r.primaryEmotion || 'neutral')
                .filter(e => e);
            const themes = reflections
                .map(r => r.theme || 'self')
                .filter(t => t);
            
            // Count occurrences
            const emotionCounts = {};
            emotions.forEach(e => emotionCounts[e] = (emotionCounts[e] || 0) + 1);
            const themeCounts = {};
            themes.forEach(t => themeCounts[t] = (themeCounts[t] || 0) + 1);
            
            // Get top 2
            const sortedEmotions = Object.entries(emotionCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 2)
                .map(([e]) => e);
            const sortedThemes = Object.entries(themeCounts)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 2)
                .map(([t]) => t);
            
            analysis = {
                success: true,
                data: {
                    dominantEmotions: sortedEmotions.length ? sortedEmotions : ['neutral'],
                    dominantThemes: sortedThemes.length ? sortedThemes : ['self'],
                    emotionalPattern: "Your reflections show a consistent pattern of self-awareness.",
                    weeklyInsight: `This week you've reflected ${reflections.length} times, exploring themes of ${sortedThemes.join(' and ') || 'personal growth'}.`,
                    reflectiveQuestion: "What would you like to explore more deeply in your next reflection?"
                }
            };
        }

        if (!analysis.success) {
            return res.status(500).json({
                success: false,
                error: analysis.error
            });
        }

        // SAVE TO CACHE
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
            analysis: analysis.data
        });
    } catch (error) {
        console.error("WEEKLY ANALYSIS ROUTE ERROR:", error);
        res.status(500).json({
            success: false,
            error: "Weekly analysis failed"
        });
    }
});

/**
 * GET /api/today-reflection/:userId
 * Get today's reflection for a user
 */
router.get("/today-reflection/:userId", async (req, res) => {
    try {
        const { userId } = req.params;
        const today = new Date().toISOString().split("T")[0];

        // Fetch reflection for today (no orderBy needed since we filter by exact date)
        const snapshot = await db
            .collection("users")
            .doc(userId)
            .collection("reflections")
            .where("date", "==", today)
            .limit(1)
            .get();

        if (snapshot.empty) {
            return res.json({
                success: true,
                hasReflection: false,
                message: "No reflection found for today"
            });
        }

        const reflection = {
            id: snapshot.docs[0].id,
            ...snapshot.docs[0].data()
        };

        return res.json({
            success: true,
            hasReflection: true,
            reflection
        });
    } catch (error) {
        console.error("TODAY REFLECTION ERROR:", error);
        res.status(500).json({
            success: false,
            error: "Failed to fetch today's reflection"
        });
    }
});

/**
 * GET /api/reflections/:userId
 * Get all reflections for a user (last 30 days)
 */
router.get("/reflections/:userId", async (req, res) => {
    try {
        const { userId } = req.params;
        const limit = parseInt(req.query.limit) || 30;

        const snapshot = await db
            .collection("users")
            .doc(userId)
            .collection("reflections")
            .orderBy("createdAt", "desc")
            .limit(limit)
            .get();

        if (snapshot.empty) {
            return res.json({
                success: true,
                reflections: []
            });
        }

        const reflections = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        return res.json({
            success: true,
            reflections
        });
    } catch (error) {
        console.error("GET REFLECTIONS ERROR:", error);
        res.status(500).json({
            success: false,
            error: "Failed to fetch reflections"
        });
    }
});


/**
 * GET /api/reflection/:userId/:date
 * Get specific reflection by date
 */
router.get("/reflection/:userId/:date", async (req, res) => {
    try {
        const { userId, date } = req.params;

        const snapshot = await db
            .collection("users")
            .doc(userId)
            .collection("reflections")
            .where("date", "==", date)
            .limit(1)
            .get();

        if (snapshot.empty) {
            return res.json({
                success: true,
                found: false,
                message: "Reflection not found"
            });
        }

        const doc = snapshot.docs[0];
        return res.json({
            success: true,
            found: true,
            reflection: {
                id: doc.id,
                ...doc.data()
            }
        });
    } catch (error) {
        console.error("GET REFLECTION ERROR:", error);
        res.status(500).json({
            success: false,
            error: "Failed to fetch reflection"
        });
    }
});

/**
 * GET /api/reflection-by-id/:userId/:docId
 * Get specific reflection by document ID (more reliable for polling)
 */
router.get("/reflection-by-id/:userId/:docId", async (req, res) => {
    try {
        const { userId, docId } = req.params;

        const docRef = db.collection("users").doc(userId).collection("reflections").doc(docId);
        const doc = await docRef.get();

        if (!doc.exists) {
            return res.json({
                success: true,
                found: false,
                message: "Reflection not found"
            });
        }

        return res.json({
            success: true,
            found: true,
            reflection: {
                id: doc.id,
                ...doc.data()
            }
        });
    } catch (error) {
        console.error("GET REFLECTION BY ID ERROR:", error);
        res.status(500).json({
            success: false,
            error: "Failed to fetch reflection"
        });
    }
});

/**
 * GET /api/user-stats/:userId
 * Get user API usage stats (for API usage page)
 */
router.get("/user-stats/:userId", async (req, res) => {
    try {
        const { userId } = req.params;

        const userDoc = await db.collection("users").doc(userId).get();

        if (!userDoc.exists) {
            return res.json({
                success: true,
                stats: {
                    apiRequestCount: 0,
                    apiLogs: [],
                    apiUsage: { byDate: {}, byType: {} }
                }
            });
        }

        const userData = userDoc.data();

        return res.json({
            success: true,
            stats: {
                apiRequestCount: userData.apiRequestCount || 0,
                apiLogs: userData.apiLogs || [],
                apiUsage: userData.apiUsage || { byDate: {}, byType: {} }
            }
        });
    } catch (error) {
        console.error("GET USER STATS ERROR:", error);
        res.status(500).json({
            success: false,
            error: "Failed to fetch user stats"
        });
    }
});

export default router;
