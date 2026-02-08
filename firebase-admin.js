import admin from 'firebase-admin';
import { readFileSync } from 'fs';
import { config } from 'dotenv';

config();

let serviceAccount;

// Try to load service account from path or base64 encoded string
if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
  try {
    const rawData = readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_PATH, 'utf8');
    serviceAccount = JSON.parse(rawData);
  } catch (error) {
    console.error('Failed to load Firebase service account from path:', error.message);
  }
} else if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
  try {
    const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
    serviceAccount = JSON.parse(decoded);
  } catch (error) {
    console.error('Failed to decode Firebase service account from base64:', error.message);
  }
}

// Initialize Firebase Admin
if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET
  });
  console.log('✅ Firebase Admin initialized successfully');
} else {
  console.warn('⚠️ Firebase Admin not initialized - no service account provided');
  // Initialize without credentials for development/testing
  admin.initializeApp({
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET
  });
}

export const db = admin.firestore();
export const storage = admin.storage();
export const auth = admin.auth();
export default admin;
