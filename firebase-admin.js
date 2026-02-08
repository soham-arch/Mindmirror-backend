import admin from 'firebase-admin';
import { config } from 'dotenv';

config();

// Prevent re-initialization
if (!admin.apps.length) {
  // Validate required env vars
  if (
    !process.env.FIREBASE_PROJECT_ID ||
    !process.env.FIREBASE_CLIENT_EMAIL ||
    !process.env.FIREBASE_PRIVATE_KEY
  ) {
    throw new Error('❌ Missing Firebase Admin environment variables');
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });

  console.log('✅ Firebase Admin initialized successfully');
}

// Exports
export const db = admin.firestore();
export const auth = admin.auth();
export const storage = admin.storage();
export default admin;