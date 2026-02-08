import express from 'express';
import cors from 'cors';
import { config } from 'dotenv';
import analysisRoutes from './routes/analysis.js';

// Load environment variables
config();

const app = express();
const PORT = process.env.PORT || 5000;

// Trust proxy (IMPORTANT for Render)
app.set('trust proxy', 1);

// Allowed origins
const allowedOrigins = [
    process.env.FRONTEND_URL,          // Vercel production URL
    'http://localhost:3000',
    'http://localhost:5173'
].filter(Boolean); // remove undefined

// CORS configuration
const corsOptions = {
    origin: (origin, callback) => {
        // Allow requests with no origin (Postman, curl, mobile apps)
        if (!origin) return callback(null, true);

        // Allow localhost (any port)
        if (/^http:\/\/localhost:\d+$/.test(origin)) {
            return callback(null, true);
        }

        // Allow listed origins
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        console.error('❌ CORS blocked:', origin);
        callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
};

// Apply CORS
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // preflight support

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.originalUrl}`);
    next();
});

// Health check endpoint (Render uses this implicitly)
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        service: 'MindMirror API',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// API routes
app.use('/api', analysisRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('🔥 Unhandled error:', err);

    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
            error: 'File too large',
            details: 'Maximum file size is 10MB'
        });
    }

    res.status(500).json({
        error: 'Internal server error',
        details: process.env.NODE_ENV === 'development'
            ? err.message
            : undefined
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
});

// Start server
app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════╗
║          🧠 MindMirror API Server              ║
╠════════════════════════════════════════════════╣
║  Status:  Running                              ║
║  Port:    ${PORT}                                  ║
║  Env:     ${process.env.NODE_ENV || 'production'}                      ║
╚════════════════════════════════════════════════╝
    `);
    console.log('Endpoints:');
    console.log('  POST /api/upload-audio');
    console.log('  POST /api/analyze-daily');
    console.log('  POST /api/analyze-weekly');
    console.log('  GET  /api/reflections/:userId');
    console.log('  GET  /api/reflection/:userId/:date');
    console.log('  GET  /api/health');
    console.log('');
});