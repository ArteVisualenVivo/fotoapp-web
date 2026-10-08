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

const CLOUDINARY_UPLOAD_MARKER = "/image/upload/";
const PUBLIC_WATERMARK_TEXT = "cesardarioph";
const PUBLIC_WATERMARK_ROWS = [-650, -520, -390, -260, -130, 0, 130, 260, 390, 520, 650];

function buildWatermarkSteps() {
  return PUBLIC_WATERMARK_ROWS.map((y, index) => {
    const x = index % 2 === 0 ? "" : ":x_90";
    return `l_text:Arial_70_bold:${PUBLIC_WATERMARK_TEXT}:co_rgb:FFFFFF:bo_3px:white:opacity_90:y_${y}${x}/fl_layer_apply`;
  });
}

// Construye la URL publica con la marca quemada en los pixeles:
// primero reduce, despues pixela los rostros detectados y encadena el
// patron de texto repetido. Idempotente: si la URL ya trae una cadena de
// transformaciones previa, la reemplaza en lugar de acumularla.
export function buildPublicImageUrl(sourceUrl, maxWidth) {
  if (!sourceUrl || !sourceUrl.includes(CLOUDINARY_UPLOAD_MARKER)) return sourceUrl;

  const markerIndex = sourceUrl.indexOf(CLOUDINARY_UPLOAD_MARKER);
  const base = sourceUrl.slice(0, markerIndex + CLOUDINARY_UPLOAD_MARKER.length);
  let tail = sourceUrl.slice(markerIndex + CLOUDINARY_UPLOAD_MARKER.length);
  // Descarta cualquier cadena de transformaciones previa (idempotencia):
  // los pasos de transformacion traen "," o ":" o arrancan con un flag conocido.
  const isTransformStep = (segment) =>
    segment.includes(",") ||
    segment.includes(":") ||
    /^(fl_|l_|e_|w_|h_|c_|f_|q_|dpr_|g_|b_|x_|y_|a_|opacity_|co_|bo_|ar_|t_|d_)/.test(segment);
  let segments = tail.split("/");
  while (segments.length > 1 && isTransformStep(segments[0])) {
    segments = segments.slice(1);
  }
  tail = segments.join("/");

  const steps = [
    `f_auto,q_auto:good,w_${maxWidth},c_limit`,
    "e_pixelate_faces:40",
    ...buildWatermarkSteps(),
  ];

  return base + steps.join("/") + "/" + tail;
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

  const baseUrl = originalUrl || resolvedUrl;
  const optimizedUrl = buildPublicImageUrl(baseUrl, 1400) || resolvedUrl;
  const thumbUrl = buildPublicImageUrl(baseUrl, 600) || optimizedUrl;

  return {
    id: docId,
    ...data,
    label: normalizeLabel(data.label),
    originalUrl,
    optimizedUrl,
    thumbUrl,
    url: optimizedUrl || resolvedUrl,
    imageUrl: optimizedUrl || resolvedUrl,
  };
}

export { auth };
