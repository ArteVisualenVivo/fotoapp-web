import { initializeApp } from "firebase/app";
import {
  collection,
  doc,
  getFirestore,
  query,
  where,
} from "firebase/firestore";
import {
  browserLocalPersistence,
  getAuth,
  indexedDBLocalPersistence,
  initializeAuth,
} from "firebase/auth";

// Firebase config
const firebaseConfig = {
  apiKey: "AIzaSyD7MB9AGLbv-oq5uM4cbhvWbIFM6btNhZA",
  authDomain: "fotoapp-fac6c.firebaseapp.com",
  projectId: "fotoapp-fac6c",
  storageBucket: "fotoapp-fac6c.firebasestorage.app",
  messagingSenderId: "244869932684",
  appId: "1:244869932684:web:b9532fb96fd2d4ba003da9"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Firestore database
export const db = getFirestore(app);

let auth;

try {
  auth = initializeAuth(app, {
    persistence: [indexedDBLocalPersistence, browserLocalPersistence],
  });
} catch {
  auth = getAuth(app);
}

export function getAuthenticatedUser() {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error("Authentication required.");
  }
  return currentUser;
}

export function getAdminSettingsRef() {
  return doc(db, "settings", "admin");
}

export function getPhotosCollection() {
  return collection(db, "photos");
}

export function getPublicPhotosQuery() {
  return query(getPhotosCollection(), where("isPortfolio", "==", true));
}

export function normalizeLabel(input) {
  const raw = `${input ?? ""}`.normalize("NFKC");
  const segments = raw
    .split("|")
    .map((part) => part.trim().replace(/\s+/g, " "))
    .filter(Boolean);

  if (segments.length === 0) return "";
  if (segments.length === 1) return segments[0];
  return segments.join(" | ");
}

export function buildCloudinaryOptimizedUrl(sourceUrl, publicId) {
  if (!sourceUrl) return "";

  if (publicId && sourceUrl.includes("/image/upload/")) {
    return sourceUrl.replace(
      "/image/upload/",
      "/image/upload/f_auto,q_auto:good,w_1800,c_limit,dpr_auto/"
    );
  }

  return sourceUrl;
}

export function normalizePhoto(docId, data) {
  const resolvedUrl =
    data.optimizedUrl ||
    data.url ||
    data.imageUrl ||
    data.secure_url ||
    data.secureUrl ||
    "";

  const originalUrl =
    data.originalUrl ||
    data.secure_url ||
    data.secureUrl ||
    data.url ||
    data.imageUrl ||
    "";

  const optimizedUrl = buildCloudinaryOptimizedUrl(
    data.optimizedUrl || originalUrl,
    data.cloudinaryPublicId
  );

  return {
    id: docId,
    ...data,
    label: normalizeLabel(data.label),
    originalUrl,
    optimizedUrl,
    url: optimizedUrl || resolvedUrl,
    imageUrl: optimizedUrl || resolvedUrl,
  };
}

export { auth };
