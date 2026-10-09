import { useEffect, useState } from 'react';
import { addDoc, deleteDoc, getDoc, getDocs, serverTimestamp, setDoc, updateDoc, doc } from 'firebase/firestore';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import {
  auth,
  buildCloudinaryOptimizedUrl,
  getAdminSettingsRef,
  getAuthenticatedUser,
  getPhotosCollection,
  normalizeLabel,
  normalizePhoto,
} from './firebase';

const CLOUDINARY_URL = 'https://api.cloudinary.com/v1_1/dqntyauau/image/upload';
const UPLOAD_PRESET = 'ml_default';
const CLOUDINARY_FOLDER = 'fotoapp-uploads';
const UPLOAD_CONCURRENCY = 3;
const UPLOAD_RETRY_ATTEMPTS = 3;
const UPLOAD_RETRY_DELAY_MS = 1000;
const IMAGE_MAX_DIMENSION = 2200;
const IMAGE_QUALITY = 0.82;
const DEFAULT_WHATSAPP_MESSAGE = 'Hola, quiero consultar por estas fotos:';
const DEFAULT_CONTACT_EMAIL = 'cesardarioph@gmail.com';
const DEFAULT_LOCATION = 'Cordoba, Argentina';
const DEFAULT_PRICING_TITLE = 'Servicios y precios';
const DEFAULT_PRICING_BODY = 'Realizo coberturas, books, recitales, bodas, 15 aÃ±os, bautismos y retratos. Tambien puedo configurar fotos individuales, packs y coberturas editoriales segun el tipo de trabajo.';
const SERVICE_TYPE_OPTIONS = ['Bodas', '15 aÃ±os', 'Bautismos', 'Boudoir', 'Paisajes', 'Only', 'Personalizado'];
const CATEGORY_OPTIONS = ['Bodas', '15 aÃ±os', 'Bautismos', 'Boudoir', 'Paisajes', 'Retratos', 'Recitales', 'Only', 'Personalizada'];

function createEmptyServicePlan() {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'Bodas',
    customType: '',
    price: '',
    description: '',
    planKind: 'individual',
    packSize: '',
    coverageNotes: '',
  };
}

function normalizeServicePlan(plan, index) {
  const nextPlan = {
    ...plan,
    id: plan?.id || `${Date.now()}-${index}`,
    type: plan?.type || 'Bodas',
    customType: plan?.customType || '',
    price: plan?.price ?? '',
    description: plan?.description ?? '',
    planKind: plan?.planKind || plan?.pricingKind || '',
    packSize: plan?.packSize ?? '',
    coverageNotes: plan?.coverageNotes ?? '',
  };

  if (!nextPlan.planKind) {
    const typeLabel = `${nextPlan.type} ${nextPlan.customType}`.toLowerCase();
    if (String(nextPlan.packSize).trim()) {
      nextPlan.planKind = 'pack';
    } else if (typeLabel.includes('individual')) {
      nextPlan.planKind = 'individual';
    } else if (typeLabel.includes('cobertura') || typeLabel.includes('coverage')) {
      nextPlan.planKind = 'coverage';
    } else {
      nextPlan.planKind = 'individual';
    }
  }

  return nextPlan;
}

function sortImagesByNewest(images) {
  return [...images].sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
}

function groupImagesByCategory(images) {
  const grouped = new Map();

  for (const image of images) {
    const categoryName = image.category?.trim() || 'Sin categoria';
    const albumTitle = image.label?.trim() || 'Sin titulo';
    const albumKey = `${categoryName}::${albumTitle}`;
    const categoryEntry = grouped.get(categoryName) || {
      name: categoryName,
      images: [],
      albumsMap: new Map(),
    };

    categoryEntry.images.push(image);

    const albumEntry = categoryEntry.albumsMap.get(albumKey) || {
      key: albumKey,
      title: albumTitle,
      category: categoryName,
      images: [],
      cover: null,
    };

    albumEntry.images.push(image);
    if (image.isCategoryCover && !albumEntry.cover) {
      albumEntry.cover = image;
    }

    categoryEntry.albumsMap.set(albumKey, albumEntry);
    grouped.set(categoryName, categoryEntry);
  }

  return Array.from(grouped.values())
    .map((entry) => {
      const albums = Array.from(entry.albumsMap.values())
        .map((album) => {
          const sortedImages = sortImagesByNewest(album.images);

          return {
            ...album,
            images: sortedImages,
            cover:
              album.cover ||
              sortedImages.find((img) => img.isFeatured) ||
              sortedImages[0] ||
              null,
          };
        })
        .sort((a, b) => {
          const aTime = a.images[0]?.createdAt?.seconds || 0;
          const bTime = b.images[0]?.createdAt?.seconds || 0;
          if (bTime !== aTime) return bTime - aTime;
          return a.title.localeCompare(b.title, 'es');
        });

      return {
        name: entry.name,
        images: sortImagesByNewest(entry.images),
        albums,
        cover:
          albums.find((album) => album.cover)?.cover ||
          entry.images.find((image) => image.isFeatured) ||
          entry.images[0] ||
          null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isImageFileCompressible(file) {
  return Boolean(file?.type?.startsWith('image/') && file.type !== 'image/gif');
}

function getFileExtensionForMimeType(mimeType) {
  if (mimeType === 'image/png') return '.png';
  if (mimeType === 'image/webp') return '.webp';
  return '.jpg';
}

async function loadImageFromFile(file) {
  const objectUrl = URL.createObjectURL(file);

  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('No se pudo leer la imagen para comprimirla.'));
      img.src = objectUrl;
    });

    return image;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function compressImageFile(file) {
  if (!isImageFileCompressible(file)) {
    return file;
  }

  try {
    const image = await loadImageFromFile(file);
    const longestSide = Math.max(image.width, image.height);

    if (file.size <= 900 * 1024 && longestSide <= IMAGE_MAX_DIMENSION) {
      return file;
    }

    const scale = Math.min(1, IMAGE_MAX_DIMENSION / longestSide);
    const targetWidth = Math.max(1, Math.round(image.width * scale));
    const targetHeight = Math.max(1, Math.round(image.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const context = canvas.getContext('2d');
    if (!context) {
      return file;
    }

    context.drawImage(image, 0, 0, targetWidth, targetHeight);

    const blob = await new Promise((resolve) => {
      canvas.toBlob(
        (result) => resolve(result),
        file.type === 'image/png' ? 'image/jpeg' : file.type || 'image/jpeg',
        IMAGE_QUALITY
      );
    });

    if (!blob || blob.size >= file.size) {
      return file;
    }

    const nextName = file.name.replace(/\.[^.]+$/, '') + getFileExtensionForMimeType(blob.type || 'image/jpeg');
    return new File([blob], nextName, { type: blob.type || 'image/jpeg', lastModified: file.lastModified });
  } catch {
    return file;
  }
}

function isRetryableUploadError(error) {
  if (!error) return false;

  if (error.retryable === false) {
    return false;
  }

  if (typeof error.status === 'number') {
    return [408, 429, 500, 502, 503, 504].includes(error.status);
  }

  return true;
}

async function withRetry(task, attempts, delayMs, onRetry) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      const shouldRetry = attempt < attempts && isRetryableUploadError(error);

      if (!shouldRetry) {
        throw error;
      }

      if (onRetry) {
        onRetry(attempt, error);
      }

      await delay(delayMs * attempt);
    }
  }

  throw lastError;
}

export default function Admin() {
  const [user, setUser] = useState(null);
  const [authReady, setAuthReady] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [images, setImages] = useState([]);
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [label, setLabel] = useState('');
  const [categoryPreset, setCategoryPreset] = useState(CATEGORY_OPTIONS[0]);
  const [customCategory, setCustomCategory] = useState('');
  const [isPortfolio, setIsPortfolio] = useState(true);
  const [isForSale, setIsForSale] = useState(true);
  const [isFeatured, setIsFeatured] = useState(false);
  const [isCategoryCover, setIsCategoryCover] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [uploadStatus, setUploadStatus] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [whatsappNumber, setWhatsappNumber] = useState('');
  const [adminName, setAdminName] = useState('');
  const [contactEmail, setContactEmail] = useState(DEFAULT_CONTACT_EMAIL);
  const [location, setLocation] = useState(DEFAULT_LOCATION);
  const [salesPageUrl, setSalesPageUrl] = useState('');
  const [whatsappMessage, setWhatsappMessage] = useState(DEFAULT_WHATSAPP_MESSAGE);
  const [pricingTitle, setPricingTitle] = useState(DEFAULT_PRICING_TITLE);
  const [pricingBody, setPricingBody] = useState(DEFAULT_PRICING_BODY);
  const [servicePlans, setServicePlans] = useState([createEmptyServicePlan()]);
  const [savingSettings, setSavingSettings] = useState(false);
  const [updatingImageId, setUpdatingImageId] = useState(null);
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const [expandedCategory, setExpandedCategory] = useState(null);
  const [expandedAlbumKey, setExpandedAlbumKey] = useState(null);
  const [previewIndex, setPreviewIndex] = useState(null);
  const [pendingAlbumDelete, setPendingAlbumDelete] = useState(null);
  const groupedImages = groupImagesByCategory(images);
  const activeCategoryGroup =
    groupedImages.find((group) => group.name === expandedCategory) || null;
  const activeAlbumGroup =
    activeCategoryGroup?.albums.find((album) => album.key === expandedAlbumKey) || null;
  const previewImage =
    activeAlbumGroup && previewIndex !== null
      ? activeAlbumGroup.images[previewIndex] || null
      : null;
  const resolvedCategory =
    categoryPreset === 'Personalizada' ? customCategory.trim() : categoryPreset.trim();
  const individualPlans = servicePlans.filter((plan) => (plan.planKind || 'individual') === 'individual');
  const packPlans = servicePlans.filter((plan) => plan.planKind === 'pack');
  const coveragePlans = servicePlans.filter((plan) => plan.planKind === 'coverage');

  const loadAdminData = async () => {
    setFetching(true);
    setUploadStatus(null);

    try {
      getAuthenticatedUser();

      const [snapshot, settingsSnapshot] = await Promise.all([
        getDocs(getPhotosCollection()),
        getDoc(getAdminSettingsRef()),
      ]);

      const docs = snapshot.docs.map((docItem) => normalizePhoto(docItem.id, docItem.data()));
      setImages(docs);

      if (settingsSnapshot.exists()) {
        const settings = settingsSnapshot.data();
        setWhatsappNumber(settings.whatsappNumber || '');
        setAdminName(settings.adminName || '');
        setContactEmail(settings.contactEmail || DEFAULT_CONTACT_EMAIL);
        setLocation(settings.location || DEFAULT_LOCATION);
        setSalesPageUrl(settings.salesPageUrl || '');
        setWhatsappMessage(settings.whatsappMessage || DEFAULT_WHATSAPP_MESSAGE);
        setPricingTitle(settings.pricingTitle || DEFAULT_PRICING_TITLE);
        setPricingBody(settings.pricingBody || DEFAULT_PRICING_BODY);
        setServicePlans(
          Array.isArray(settings.servicePlans) && settings.servicePlans.length > 0
            ? settings.servicePlans.map((plan, index) => normalizeServicePlan(plan, index))
            : [createEmptyServicePlan()]
        );
      }
    } catch (error) {
      console.error('Error fetching admin data:', error);
      setUploadStatus({
        type: 'error',
        message: 'No se pudieron cargar los datos del panel.',
        details: [error.message],
      });
    } finally {
      setFetching(false);
    }
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      if (!currentUser) {
        setImages([]);
        setSelectedFiles([]);
        setUploadProgress(null);
        setFetching(false);
      }
      setAuthReady(true);
    });

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!authReady) {
      return;
    }

    if (!user) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void loadAdminData();
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [authReady, user]);

  useEffect(() => {
    if (!previewImage) return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setPreviewIndex(null);
      }

      if (!activeAlbumGroup) return;

      if (event.key === 'ArrowRight') {
        setPreviewIndex((current) => (current + 1) % activeAlbumGroup.images.length);
      }

      if (event.key === 'ArrowLeft') {
        setPreviewIndex((current) =>
          (current - 1 + activeAlbumGroup.images.length) % activeAlbumGroup.images.length
        );
      }

      if ((event.key === 'Delete' || event.key === 'Backspace') && previewImage) {
        event.preventDefault();
        event.stopPropagation();
        void deleteImage(previewImage, { keepPreviewOpen: true });
      }
    };

    window.addEventListener('keydown', handleEscape);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleEscape);
    };
  }, [previewImage, activeAlbumGroup]);

  const handleLogin = async () => {
    setLoginLoading(true);
    setUploadStatus(null);

    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (error) {
      alert(`No se pudo iniciar sesion: ${error.message}`);
    } finally {
      setLoginLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  const handleFileSelect = (e) => {
    setSelectedFiles(Array.from(e.target.files ?? []));
  };

  const goToPreviousPreview = () => {
    if (!activeAlbumGroup) return;
    setPreviewIndex((current) => (current - 1 + activeAlbumGroup.images.length) % activeAlbumGroup.images.length);
  };

  const goToNextPreview = () => {
    if (!activeAlbumGroup) return;
    setPreviewIndex((current) => (current + 1) % activeAlbumGroup.images.length);
  };

  const updateServicePlan = (id, key, value) => {
    setServicePlans((currentPlans) =>
      currentPlans.map((plan) => (plan.id === id ? { ...plan, [key]: value } : plan))
    );
  };

  const addServicePlan = () => {
    setServicePlans((currentPlans) => [...currentPlans, createEmptyServicePlan()]);
  };

  const addServicePlanOfKind = (planKind) => {
    setServicePlans((currentPlans) => [
      ...currentPlans,
      {
        ...createEmptyServicePlan(),
        planKind,
      },
    ]);
  };

  const removeServicePlan = (id) => {
    setServicePlans((currentPlans) => {
      if (currentPlans.length === 1) {
        return [createEmptyServicePlan()];
      }

      return currentPlans.filter((plan) => plan.id !== id);
    });
  };

  const removeServicePlansOfKind = (planKind) => {
    setServicePlans((currentPlans) => {
      const nextPlans = currentPlans.filter((plan) => (plan.planKind || 'individual') !== planKind);
      return nextPlans.length > 0 ? nextPlans : [createEmptyServicePlan()];
    });
  };

  const saveAdminSettings = async () => {
    setSavingSettings(true);

    try {
      getAuthenticatedUser();

      const sanitizedServicePlans = servicePlans
        .map((plan) => {
          const nextPlan = {
            ...plan,
            id: plan.id,
            type: plan.type,
            customType: plan.type === 'Personalizado' ? plan.customType.trim() : (plan.customType || ''),
            price: String(plan.price || '').trim(),
            description: String(plan.description || '').trim(),
            planKind: String(plan.planKind || '').trim(),
            packSize: String(plan.packSize || '').trim(),
            coverageNotes: String(plan.coverageNotes || '').trim(),
          };

          if (!nextPlan.planKind) {
            nextPlan.planKind = nextPlan.packSize ? 'pack' : 'individual';
          }

          return nextPlan;
        })
        .filter((plan) => {
          const resolvedType = plan.type === 'Personalizado' ? plan.customType : plan.type;
          return resolvedType && plan.price;
        });

      await setDoc(
        getAdminSettingsRef(),
        {
          whatsappNumber,
          adminName,
          contactEmail,
          location,
          salesPageUrl,
          whatsappMessage,
          pricingTitle,
          pricingBody,
          servicePlans: sanitizedServicePlans,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      setUploadStatus({
        type: 'success',
        message: 'Cambios guardados con exito.',
      });
      setTimeout(() => setUploadStatus(null), 3000);
    } catch (error) {
      setUploadStatus({
        type: 'error',
        message: 'No se pudo guardar la configuracion.',
        details: [error.message],
      });
    } finally {
      setSavingSettings(false);
    }
  };

  const uploadImages = async () => {
    if (selectedFiles.length === 0) return;
    if (!resolvedCategory) {
      setUploadStatus({
        type: 'error',
        message: 'Escribe una categoria propia para continuar.',
      });
      return;
    }

    setLoading(true);
    setUploadStatus(null);
    const currentUser = getAuthenticatedUser();
    const errors = [];
    let successCount = 0;
    let errorCount = 0;
    let completedCount = 0;
    let activeCount = 0;

    setUploadProgress({
      total: selectedFiles.length,
      completed: 0,
      success: 0,
      failed: 0,
      active: 0,
      currentFile: '',
      phase: 'Preparando archivos...',
      percent: 0,
    });

    const updateProgress = (patch) => {
      setUploadProgress((current) => {
        if (!current) return current;

        const next = { ...current, ...patch };
        next.percent = next.total > 0 ? Math.round((next.completed / next.total) * 100) : 0;
        return next;
      });
    };

    const uploadSingleFile = async (file) => {
      const preparedFile = await compressImageFile(file);

      updateProgress({ currentFile: file.name, phase: 'Subiendo a Cloudinary...' });

      const uploadResponse = await withRetry(
        async () => {
          const formData = new FormData();
          formData.append('file', preparedFile);
          formData.append('upload_preset', UPLOAD_PRESET);
          formData.append('folder', CLOUDINARY_FOLDER);
          formData.append('context', `app=fotoapp|owner=${currentUser.uid}`);

          const res = await fetch(CLOUDINARY_URL, {
            method: 'POST',
            body: formData,
          });

          if (!res.ok) {
            const responseText = await res.text().catch(() => '');
            const uploadError = new Error(
              responseText || `Failed to upload image to Cloudinary (${res.status})`
            );
            uploadError.status = res.status;
            uploadError.retryable = [408, 429, 500, 502, 503, 504].includes(res.status);
            throw uploadError;
          }

          const data = await res.json();

          if (!data.secure_url) {
            const uploadError = new Error('Failed to get image URL from Cloudinary');
            uploadError.retryable = false;
            throw uploadError;
          }

          return data;
        },
        UPLOAD_RETRY_ATTEMPTS,
        UPLOAD_RETRY_DELAY_MS,
        (attempt) => {
          updateProgress({
            currentFile: file.name,
            phase: `Reintentando subida (${attempt + 1}/${UPLOAD_RETRY_ATTEMPTS})...`,
          });
        }
      );

      const optimizedUrl = buildCloudinaryOptimizedUrl(
        uploadResponse.secure_url,
        uploadResponse.public_id
      );

      const isDuplicate = images.some(
        (img) =>
          img.originalUrl === uploadResponse.secure_url ||
          img.url === uploadResponse.secure_url ||
          img.optimizedUrl === optimizedUrl
      );

      if (isDuplicate) {
        const duplicateError = new Error('Already uploaded');
        duplicateError.retryable = false;
        throw duplicateError;
      }

      const uploadedData = {
        url: optimizedUrl || uploadResponse.secure_url,
        imageUrl: optimizedUrl || uploadResponse.secure_url,
        optimizedUrl: optimizedUrl || uploadResponse.secure_url,
        originalUrl: uploadResponse.secure_url,
        label: normalizeLabel(label),
        category: resolvedCategory,
        isPortfolio,
        isForSale,
        isFeatured,
        isCategoryCover,
        uploadedBy: currentUser.uid,
        cloudinaryPublicId: uploadResponse.public_id || null,
        createdAt: serverTimestamp(),
      };

      const docRef = await addDoc(getPhotosCollection(), uploadedData);
      return { id: docRef.id, ...uploadedData };
    };

    const tasks = selectedFiles.map((file) => async () => {
      activeCount += 1;
      updateProgress({
        active: activeCount,
        currentFile: file.name,
        phase: 'Preparando imagen...',
      });

      try {
        const result = await uploadSingleFile(file);
        successCount += 1;
        return result;
      } catch (error) {
        errorCount += 1;
        errors.push(`${file.name} - ${error.message}`);
        return null;
      } finally {
        completedCount += 1;
        activeCount -= 1;
        updateProgress({
          completed: completedCount,
          success: successCount,
          failed: errorCount,
          active: activeCount,
          currentFile: file.name,
          phase: completedCount < selectedFiles.length ? 'Procesando siguiente archivo...' : 'Finalizando...',
        });
      }
    });

    let nextTaskIndex = 0;
    const workers = Array.from({ length: Math.min(UPLOAD_CONCURRENCY, tasks.length) }, async () => {
      while (nextTaskIndex < tasks.length) {
        const taskIndex = nextTaskIndex;
        nextTaskIndex += 1;
        const task = tasks[taskIndex];
        await task();
      }
    });

    await Promise.all(workers);

    setSelectedFiles([]);
    setLabel('');
    setCustomCategory('');
    setCategoryPreset(CATEGORY_OPTIONS[0]);
    setIsCategoryCover(false);
    setLoading(false);

    if (successCount > 0) {
      await loadAdminData();
    }

    if (errorCount > 0) {
      setUploadStatus({
        type: 'error',
        message: `${successCount} uploaded, ${errorCount} failed`,
        details: errors,
      });
    } else if (successCount > 0) {
      setUploadStatus({
        type: 'success',
        message: `Successfully uploaded ${successCount} image${successCount > 1 ? 's' : ''}.`,
      });
      setTimeout(() => setUploadStatus(null), 3000);
    }

    setTimeout(() => setUploadProgress(null), 1500);
  };

  const setCategoryCover = async (targetImage) => {
    if (!targetImage?.id) return;

    setUpdatingImageId(targetImage.id);
    setUploadStatus(null);
    const nextValue = !targetImage.isCategoryCover;

    try {
      getAuthenticatedUser();

      await updateDoc(doc(getPhotosCollection(), targetImage.id), {
        isCategoryCover: nextValue,
      });

      await loadAdminData();
      setUploadStatus({
        type: 'success',
        message: nextValue ? 'Portada de categoria actualizada.' : 'Portada quitada.',
      });
      setTimeout(() => setUploadStatus(null), 2500);
    } catch (error) {
      setUploadStatus({
        type: 'error',
        message: 'No se pudo actualizar la portada.',
        details: [error.message],
      });
    } finally {
      setUpdatingImageId(null);
    }
  };

  const openAlbum = (albumKey) => {
    setExpandedAlbumKey(albumKey);
    setPreviewIndex(null);
  };

  const returnToAlbumBrowser = () => {
    setExpandedAlbumKey(null);
    setPreviewIndex(null);
  };

  const deleteAlbumAssetInCloudinary = async (publicId, idToken) => {
    if (!publicId) return;

    const response = await fetch('/api/delete-photo', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ publicId }),
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || result.details || 'No se pudo eliminar en Cloudinary');
    }
  };

  const requestAlbumDelete = (album) => {
    if (!album) return;

    setPendingAlbumDelete(album);
  };

  const confirmAlbumDelete = async () => {
    if (!pendingAlbumDelete) return;

    const albumToDelete = pendingAlbumDelete;
    setPendingAlbumDelete(null);
    setUpdatingImageId(albumToDelete.key);
    setUploadStatus(null);

    try {
      const currentUser = getAuthenticatedUser();
      const idToken = await currentUser.getIdToken();

      await Promise.all(
        albumToDelete.images
          .filter((image) => image.cloudinaryPublicId)
          .map((image) => withRetry(
            () => deleteAlbumAssetInCloudinary(image.cloudinaryPublicId, idToken),
            UPLOAD_RETRY_ATTEMPTS,
            UPLOAD_RETRY_DELAY_MS
          ))
      );

      await Promise.all(albumToDelete.images.map((image) => deleteDoc(doc(getPhotosCollection(), image.id))));

      if (activeAlbumGroup?.key === albumToDelete.key) {
        setPreviewIndex(null);
        setExpandedAlbumKey(null);
      }

      await loadAdminData();
      setUploadStatus({
        type: 'success',
        message: `Album "${albumToDelete.title}" eliminado correctamente.`,
      });
      setTimeout(() => setUploadStatus(null), 2500);
    } catch (error) {
      setUploadStatus({
        type: 'error',
        message: 'No se pudo eliminar el album.',
        details: [error.message],
      });
    } finally {
      setUpdatingImageId(null);
    }
  };

  const toggleFeaturedImage = async (targetImage) => {
    if (!targetImage?.id) return;

    setUpdatingImageId(targetImage.id);
    setUploadStatus(null);

    try {
      getAuthenticatedUser();
      await updateDoc(doc(getPhotosCollection(), targetImage.id), {
        isFeatured: !targetImage.isFeatured,
      });
      await loadAdminData();
    } catch (error) {
      setUploadStatus({
        type: 'error',
        message: 'No se pudo actualizar el destacado.',
        details: [error.message],
      });
    } finally {
      setUpdatingImageId(null);
    }
  };

  const togglePortfolioImage = async (targetImage) => {
    if (!targetImage?.id) return;

    setUpdatingImageId(targetImage.id);
    setUploadStatus(null);

    try {
      getAuthenticatedUser();
      await updateDoc(doc(getPhotosCollection(), targetImage.id), {
        isPortfolio: !targetImage.isPortfolio,
      });
      await loadAdminData();
    } catch (error) {
      setUploadStatus({
        type: 'error',
        message: 'No se pudo actualizar la visibilidad del portfolio.',
        details: [error.message],
      });
    } finally {
      setUpdatingImageId(null);
    }
  };

  const toggleForSaleImage = async (targetImage) => {
    if (!targetImage?.id) return;

    setUpdatingImageId(targetImage.id);
    setUploadStatus(null);

    try {
      getAuthenticatedUser();
      await updateDoc(doc(getPhotosCollection(), targetImage.id), {
        isForSale: !targetImage.isForSale,
      });
      await loadAdminData();
    } catch (error) {
      setUploadStatus({
        type: 'error',
        message: 'No se pudo actualizar la disponibilidad de venta.',
        details: [error.message],
      });
    } finally {
      setUpdatingImageId(null);
    }
  };

  const hideAllFromPortfolio = async (targetImages) => {
    if (!targetImages || targetImages.length === 0) return;

    const confirmed = window.confirm(
      `Se van a quitar del portfolio ${targetImages.length} foto(s). No se borran, solo dejan de mostrarse en la web. Continuar?`
    );
    if (!confirmed) return;

    setBulkUpdating(true);
    setUploadStatus(null);

    try {
      getAuthenticatedUser();
      await Promise.all(
        targetImages.map((image) =>
          updateDoc(doc(getPhotosCollection(), image.id), { isPortfolio: false })
        )
      );
      await loadAdminData();
      setUploadStatus({
        type: 'success',
        message: `${targetImages.length} foto(s) quitada(s) del portfolio.`,
      });
      setTimeout(() => setUploadStatus(null), 2500);
    } catch (error) {
      setUploadStatus({
        type: 'error',
        message: 'No se pudo quitar las fotos del portfolio.',
        details: [error.message],
      });
    } finally {
      setBulkUpdating(false);
    }
  };

  const showAllInPortfolio = async (targetImages) => {
    if (!targetImages || targetImages.length === 0) return;

    const confirmed = window.confirm(
      `Se van a mostrar en el portfolio ${targetImages.length} foto(s). No se borran ni se toca la tienda. Continuar?`
    );
    if (!confirmed) return;

    setBulkUpdating(true);
    setUploadStatus(null);

    try {
      getAuthenticatedUser();
      await Promise.all(
        targetImages.map((image) =>
          updateDoc(doc(getPhotosCollection(), image.id), { isPortfolio: true })
        )
      );
      await loadAdminData();
      setUploadStatus({
        type: 'success',
        message: `${targetImages.length} foto(s) mostrada(s) en el portfolio.`,
      });
      setTimeout(() => setUploadStatus(null), 2500);
    } catch (error) {
      setUploadStatus({
        type: 'error',
        message: 'No se pudo mostrar las fotos en el portfolio.',
        details: [error.message],
      });
    } finally {
      setBulkUpdating(false);
    }
  };

  const setAllForSale = async (targetImages, value) => {
    if (!targetImages || targetImages.length === 0) return;

    const accion = value ? 'poner en venta' : 'quitar de la venta';
    const confirmed = window.confirm(
      `Se van a ${accion} ${targetImages.length} foto(s) de la tienda. Continuar?`
    );
    if (!confirmed) return;

    setBulkUpdating(true);
    setUploadStatus(null);

    try {
      getAuthenticatedUser();
      await Promise.all(
        targetImages.map((image) =>
          updateDoc(doc(getPhotosCollection(), image.id), { isForSale: value })
        )
      );
      await loadAdminData();
      setUploadStatus({
        type: 'success',
        message: `${targetImages.length} foto(s) actualizada(s) en la tienda.`,
      });
      setTimeout(() => setUploadStatus(null), 2500);
    } catch (error) {
      setUploadStatus({
        type: 'error',
        message: 'No se pudo actualizar la venta de las fotos.',
        details: [error.message],
      });
    } finally {
      setBulkUpdating(false);
    }
  };

  const deleteImage = async (targetImage, options = {}) => {
    if (!targetImage?.id) return;

    const confirmDelete = window.confirm(`Eliminar "${targetImage.label || 'esta foto'}"?`);
    if (!confirmDelete) return;

    setUpdatingImageId(targetImage.id);
    setUploadStatus(null);

    try {
      const currentUser = getAuthenticatedUser();
      const idToken = await currentUser.getIdToken();

      if (targetImage.cloudinaryPublicId) {
        const response = await fetch('/api/delete-photo', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify({
            publicId: targetImage.cloudinaryPublicId,
          }),
        });

        const result = await response.json();
        if (!response.ok) {
          throw new Error(result.error || result.details || 'No se pudo eliminar en Cloudinary');
        }
      }

      await deleteDoc(doc(getPhotosCollection(), targetImage.id));
      await loadAdminData();
      if (!options.keepPreviewOpen) {
        setPreviewIndex(null);
      }
      setUploadStatus({
        type: 'success',
        message: 'Foto eliminada correctamente.',
      });
      setTimeout(() => setUploadStatus(null), 2500);
    } catch (error) {
      setUploadStatus({
        type: 'error',
        message: 'No se pudo eliminar la foto.',
        details: [error.message],
      });
    } finally {
      setUpdatingImageId(null);
    }
  };

  if (!authReady) {
    return (
      <div style={{ padding: 20, fontFamily: 'Arial', maxWidth: '400px', margin: '100px auto', textAlign: 'center' }}>
        Verificando sesion...
      </div>
    );
  }

  if (!user) {
    return (
      <div style={{ padding: 20, fontFamily: 'Arial', maxWidth: '400px', margin: '100px auto' }}>
        <h2>Ingreso al admin</h2>
        <input
          type="email"
          placeholder="Ingresar correo"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ width: '100%', padding: '10px', marginBottom: '10px' }}
        />
        <div className="admin-password-wrap" style={{ marginBottom: '10px' }}>
          <input
            type={showPassword ? 'text' : 'password'}
            placeholder="Ingresar clave"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={{ width: '100%', padding: '10px 44px 10px 10px' }}
          />
          <button
            type="button"
            className="admin-password-toggle"
            onClick={() => setShowPassword((current) => !current)}
          >
            {showPassword ? 'Ocultar' : 'Ver'}
          </button>
        </div>
        <button onClick={handleLogin} disabled={loginLoading} style={{ width: '100%', padding: '10px' }}>
          {loginLoading ? 'Ingresando...' : 'Ingresar'}
        </button>
      </div>
    );
  }

  return (
    <div style={{ padding: '20px', fontFamily: 'system-ui, -apple-system, sans-serif', maxWidth: '800px', margin: '0 auto', minHeight: '100vh' }}>
      <style>{`
        input:not([type="checkbox"]):focus, textarea:focus, select:focus {
          outline: none;
          border-color: #4CAF50 !important;
          box-shadow: 0 0 0 3px rgba(76, 175, 80, 0.1) !important;
        }
        select {
          color: #111827;
          background: #ffffff;
        }
        select option {
          color: #111827;
          background: #ffffff;
        }
        .admin-category-block {
          margin-bottom: 24px;
          padding: 16px;
          border-radius: 16px;
          border: 1px solid #e5e7eb;
          background: #f9fafb;
        }
        .admin-category-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          margin-bottom: 14px;
          flex-wrap: wrap;
        }
        .admin-category-title {
          margin: 0;
          font-size: 1rem;
          font-weight: 700;
          color: #111827;
        }
        .admin-category-count {
          color: #6b7280;
          font-size: 0.85rem;
          font-weight: 600;
        }
        .admin-images-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
          gap: 16px;
        }
        .admin-category-browser {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
          gap: 18px;
        }
        .admin-album-browser {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
          gap: 16px;
        }
        .admin-album-card {
          position: relative;
          border: 1px solid #e5e7eb;
          border-radius: 18px;
          background: #ffffff;
          overflow: hidden;
          cursor: pointer;
          box-shadow: 0 10px 24px rgba(15, 23, 42, 0.08);
          transition: transform 0.2s ease, box-shadow 0.2s ease;
          text-align: left;
          padding: 0;
        }
        .admin-album-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 16px 28px rgba(15, 23, 42, 0.12);
        }
        .admin-album-card img {
          width: 100%;
          height: 180px;
          object-fit: cover;
          display: block;
          background: #f3f4f6;
        }
        .admin-album-card-body {
          padding: 14px;
        }
        .admin-album-card-title {
          margin: 0;
          font-size: 1rem;
          font-weight: 700;
          color: #111827;
        }
        .admin-album-card-meta {
          margin-top: 6px;
          color: #6b7280;
          font-size: 0.86rem;
          font-weight: 600;
          line-height: 1.4;
        }
        .admin-album-card-actions {
          display: flex;
          justify-content: flex-end;
          padding: 0 14px 14px;
        }
        .admin-album-delete {
          border: none;
          border-radius: 999px;
          padding: 8px 12px;
          font-size: 0.78rem;
          font-weight: 700;
          cursor: pointer;
          background: #fee2e2;
          color: #991b1b;
        }
        .admin-category-card {
          border: 1px solid #e5e7eb;
          border-radius: 18px;
          background: #ffffff;
          overflow: hidden;
          cursor: pointer;
          box-shadow: 0 10px 24px rgba(15, 23, 42, 0.08);
          transition: transform 0.2s ease, box-shadow 0.2s ease;
          text-align: left;
        }
        .admin-category-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 16px 28px rgba(15, 23, 42, 0.12);
        }
        .admin-category-card img {
          width: 100%;
          height: 180px;
          object-fit: cover;
          display: block;
          background: #f3f4f6;
        }
        .admin-category-card-body {
          padding: 14px;
        }
        .admin-category-card-title {
          margin: 0;
          font-size: 1rem;
          font-weight: 700;
          color: #111827;
        }
        .admin-category-card-meta {
          margin-top: 6px;
          color: #6b7280;
          font-size: 0.86rem;
          font-weight: 600;
        }
        .admin-gallery-toolbar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          margin-bottom: 18px;
          flex-wrap: wrap;
        }
        .admin-gallery-back {
          border: none;
          border-radius: 999px;
          background: #111827;
          color: #ffffff;
          padding: 10px 16px;
          font-weight: 600;
          cursor: pointer;
        }
        .admin-gallery-title {
          margin: 0;
          font-size: 1.1rem;
          font-weight: 700;
          color: #111827;
        }
        .admin-image-card {
          position: relative;
          border-radius: 14px;
          overflow: hidden;
          background: #f5f5f5;
          border: 1px solid #eee;
        }
        .admin-image-preview-button {
          border: none;
          padding: 0;
          margin: 0;
          background: transparent;
          cursor: zoom-in;
          display: block;
          width: 100%;
        }
        .admin-password-wrap {
          position: relative;
        }
        .admin-password-toggle {
          position: absolute;
          top: 50%;
          right: 12px;
          transform: translateY(-50%);
          border: none;
          background: transparent;
          color: #d1d5db;
          cursor: pointer;
          font-size: 0.9rem;
          fontWeight: 700;
          padding: 4px 6px;
        }
        .admin-preview-overlay {
          position: fixed;
          inset: 0;
          z-index: 80;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          background: rgba(15, 23, 42, 0.82);
          backdrop-filter: blur(6px);
        }
        .admin-preview-modal {
          width: min(960px, 100%);
          max-height: calc(100vh - 48px);
          overflow: auto;
          border-radius: 20px;
          background: #ffffff;
          box-shadow: 0 24px 50px rgba(15, 23, 42, 0.26);
        }
        .admin-preview-image {
          width: 100%;
          max-height: 72vh;
          object-fit: contain;
          display: block;
          background: #111827;
        }
        .admin-preview-body {
          padding: 18px;
        }
        .admin-preview-top {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          margin-bottom: 12px;
          flex-wrap: wrap;
        }
        .admin-preview-close {
          border: none;
          border-radius: 999px;
          background: #111827;
          color: #ffffff;
          padding: 10px 14px;
          font-weight: 600;
          cursor: pointer;
        }
        .admin-preview-nav {
          position: absolute;
          top: 50%;
          transform: translateY(-50%);
          width: 48px;
          height: 48px;
          border: none;
          border-radius: 999px;
          background: rgba(17, 24, 39, 0.82);
          color: #ffffff;
          font-size: 1.4rem;
          cursor: pointer;
        }
        .admin-preview-nav-left {
          left: 16px;
        }
        .admin-preview-nav-right {
          right: 16px;
        }
        .admin-preview-image-wrap {
          position: relative;
          background: #111827;
        }
        .admin-preview-mobile-nav {
          display: none;
          gap: 10px;
          margin-top: 14px;
        }
        .admin-delete-overlay {
          position: fixed;
          inset: 0;
          z-index: 90;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          background: rgba(15, 23, 42, 0.82);
          backdrop-filter: blur(6px);
        }
        .admin-delete-modal {
          width: min(520px, 100%);
          border-radius: 20px;
          background: #ffffff;
          box-shadow: 0 24px 50px rgba(15, 23, 42, 0.26);
          padding: 20px;
        }
        .admin-delete-title {
          margin: 0;
          font-size: 1.1rem;
          font-weight: 700;
          color: #111827;
        }
        .admin-delete-body {
          margin-top: 10px;
          color: #6b7280;
          font-size: 0.95rem;
          line-height: 1.5;
        }
        .admin-delete-actions {
          display: flex;
          justify-content: flex-end;
          gap: 10px;
          margin-top: 18px;
          flex-wrap: wrap;
        }
        .admin-delete-cancel {
          border: 1px solid #d1d5db;
          border-radius: 999px;
          background: #ffffff;
          color: #111827;
          padding: 10px 14px;
          font-weight: 600;
          cursor: pointer;
        }
        .admin-delete-confirm {
          border: none;
          border-radius: 999px;
          background: #dc2626;
          color: #ffffff;
          padding: 10px 14px;
          font-weight: 600;
          cursor: pointer;
        }
        @media (max-width: 640px) {
          .admin-category-block {
            padding: 12px;
            border-radius: 14px;
          }
          .admin-category-browser {
            grid-template-columns: 1fr;
            gap: 14px;
          }
          .admin-images-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 12px;
          }
          .admin-album-browser {
            grid-template-columns: 1fr;
            gap: 14px;
          }
          .admin-preview-nav {
            display: none;
          }
          .admin-delete-actions {
            justify-content: stretch;
          }
          .admin-delete-cancel,
          .admin-delete-confirm {
            width: 100%;
          }
          .admin-preview-mobile-nav {
            display: flex;
          }
        }
        input[type="file"] {
          padding: 10px;
          border: 2px dashed #ddd;
          border-radius: 6px;
          cursor: pointer;
        }
        button:hover:not(:disabled) {
          opacity: 0.9;
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(0,0,0,0.15) !important;
        }
        .status-message {
          padding: 12px;
          border-radius: 6px;
          margin-bottom: 16px;
          font-weight: 500;
          animation: slideIn 0.3s ease-out;
        }
        @keyframes slideIn {
          from { transform: translateY(-10px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
      `}</style>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px', paddingBottom: '20px', borderBottom: '2px solid #eee' }}>
        <h1 style={{ margin: '0', fontSize: '2rem', fontWeight: '600' }}>Admin Panel</h1>
        <button onClick={handleLogout} style={{ padding: '10px 20px', background: '#f44336', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: '600', transition: 'all 0.2s' }}>
          Cerrar sesion
        </button>
      </div>

      <div style={{ background: '#f9f9f9', padding: '24px', borderRadius: '12px', marginBottom: '30px', border: '1px solid #eee' }}>
        <h3 style={{ marginTop: '0', marginBottom: '16px', fontSize: '1.2rem' }}>Configuracion de contacto</h3>

        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500' }}>Nombre del admin o fotografo</label>
          <input
            type="text"
            value={adminName}
            onChange={(e) => setAdminName(e.target.value)}
            placeholder="Ej: Juan Perez Fotografia"
            style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: '6px', fontSize: '1rem', boxSizing: 'border-box', transition: 'all 0.2s' }}
          />
        </div>

        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500' }}>Numero de WhatsApp del admin</label>
          <input
            type="text"
            value={whatsappNumber}
            onChange={(e) => setWhatsappNumber(e.target.value)}
            placeholder="Ej: 3512417121"
            style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: '6px', fontSize: '1rem', boxSizing: 'border-box', transition: 'all 0.2s' }}
          />
        </div>

        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500' }}>Correo de contacto</label>
          <input
            type="email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            placeholder="cesardarioph@gmail.com"
            style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: '6px', fontSize: '1rem', boxSizing: 'border-box', transition: 'all 0.2s' }}
          />
        </div>

        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500' }}>Ubicacion</label>
          <input
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="Cordoba, Argentina"
            style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: '6px', fontSize: '1rem', boxSizing: 'border-box', transition: 'all 0.2s' }}
          />
        </div>

        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500' }}>Mensaje base de WhatsApp</label>
          <textarea
            value={whatsappMessage}
            onChange={(e) => setWhatsappMessage(e.target.value)}
            placeholder={DEFAULT_WHATSAPP_MESSAGE}
            rows={4}
            style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: '6px', fontSize: '1rem', boxSizing: 'border-box', transition: 'all 0.2s', resize: 'vertical' }}
          />
        </div>

        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500' }}>Link de tu pagina de ventas</label>
          <input
            type="url"
            value={salesPageUrl}
            onChange={(e) => setSalesPageUrl(e.target.value)}
            placeholder="https://tu-pagina-de-ventas.com"
            style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: '6px', fontSize: '1rem', boxSizing: 'border-box', transition: 'all 0.2s' }}
          />
        </div>

        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500' }}>Titulo de precios</label>
          <input
            type="text"
            value={pricingTitle}
            onChange={(e) => setPricingTitle(e.target.value)}
            placeholder={DEFAULT_PRICING_TITLE}
            style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: '6px', fontSize: '1rem', boxSizing: 'border-box', transition: 'all 0.2s' }}
          />
        </div>

        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500' }}>Texto de precios</label>
          <textarea
            value={pricingBody}
            onChange={(e) => setPricingBody(e.target.value)}
            placeholder={DEFAULT_PRICING_BODY}
            rows={5}
            style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: '6px', fontSize: '1rem', boxSizing: 'border-box', transition: 'all 0.2s', resize: 'vertical' }}
          />
        </div>

        <div style={{ marginBottom: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', marginBottom: '12px', flexWrap: 'wrap' }}>
            <label style={{ display: 'block', fontWeight: '600' }}>Planes y precios</label>
            <button
              type="button"
              onClick={addServicePlan}
              style={{
                padding: '8px 14px',
                background: '#1f6b4f',
                color: 'white',
                border: 'none',
                borderRadius: '999px',
                cursor: 'pointer',
                fontWeight: '600',
              }}
            >
              Agregar plan
            </button>
          </div>

          <div style={{ display: 'grid', gap: '14px' }}>
            <div style={{ padding: '14px 16px', background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ fontWeight: 700 }}>Fotos individuales</div>
                <button type="button" onClick={() => addServicePlanOfKind('individual')} style={{ padding: '7px 12px', background: '#111827', color: '#fff', border: 'none', borderRadius: '999px', cursor: 'pointer', fontWeight: '600', fontSize: '0.88rem' }}>
                  Agregar foto individual
                </button>
              </div>
              <div style={{ fontSize: '0.92rem', color: '#6b7280', marginTop: '4px' }}>
                {individualPlans.length > 0 ? `${individualPlans.length} plan(es) configurado(s).` : 'Sin planes individuales configurados todavía.'}
              </div>
              <div style={{ display: 'grid', gap: '12px', marginTop: '14px' }}>
                {individualPlans.map((plan) => (
                  <div key={plan.id} style={{ padding: '16px', background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: '12px' }}>
                    <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500' }}>Precio por foto individual</label>
                    <input type="number" min="0" step="1" value={plan.price} onChange={(e) => updateServicePlan(plan.id, 'price', e.target.value)} placeholder="Ej: 5000" style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: '6px', fontSize: '1rem', boxSizing: 'border-box', transition: 'all 0.2s' }} />
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}>
                      <button type="button" onClick={() => removeServicePlan(plan.id)} style={{ padding: '8px 12px', background: '#fee2e2', color: '#991b1b', border: 'none', borderRadius: '999px', cursor: 'pointer', fontWeight: '600' }}>
                        Quitar plan
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ padding: '14px 16px', background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ fontWeight: 700 }}>Packs</div>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <button type="button" onClick={() => addServicePlanOfKind('pack')} style={{ padding: '7px 12px', background: '#111827', color: '#fff', border: 'none', borderRadius: '999px', cursor: 'pointer', fontWeight: '600', fontSize: '0.88rem' }}>
                    Agregar pack
                  </button>
                  <button type="button" onClick={() => removeServicePlansOfKind('pack')} style={{ padding: '7px 12px', background: '#fee2e2', color: '#991b1b', border: 'none', borderRadius: '999px', cursor: 'pointer', fontWeight: '600', fontSize: '0.88rem' }}>
                    Quitar packs
                  </button>
                </div>
              </div>
              <div style={{ fontSize: '0.92rem', color: '#6b7280', marginTop: '4px' }}>
                {packPlans.length > 0 ? `${packPlans.length} pack(s) configurado(s).` : 'Sin packs configurados todavía.'}
              </div>
              <div style={{ display: 'grid', gap: '12px', marginTop: '14px' }}>
                {packPlans.map((plan) => (
                  <div key={plan.id} style={{ padding: '16px', background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: '12px' }}>
                    <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500' }}>Cantidad de fotos del pack</label>
                    <input type="number" min="0" step="1" value={plan.packSize} onChange={(e) => updateServicePlan(plan.id, 'packSize', e.target.value)} placeholder="Ej: 5, 10, 20" style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: '6px', fontSize: '1rem', boxSizing: 'border-box', transition: 'all 0.2s' }} />
                    <div style={{ marginTop: '12px' }}>
                      <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500' }}>Precio del pack</label>
                      <input type="number" min="0" step="1" value={plan.price} onChange={(e) => updateServicePlan(plan.id, 'price', e.target.value)} placeholder="Ej: 30000" style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: '6px', fontSize: '1rem', boxSizing: 'border-box', transition: 'all 0.2s' }} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}>
                      <button type="button" onClick={() => removeServicePlan(plan.id)} style={{ padding: '8px 12px', background: '#fee2e2', color: '#991b1b', border: 'none', borderRadius: '999px', cursor: 'pointer', fontWeight: '600' }}>
                        Quitar plan
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ padding: '14px 16px', background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ fontWeight: 700 }}>Coberturas</div>
                <button type="button" onClick={() => addServicePlanOfKind('coverage')} style={{ padding: '7px 12px', background: '#111827', color: '#fff', border: 'none', borderRadius: '999px', cursor: 'pointer', fontWeight: '600', fontSize: '0.88rem' }}>
                  Agregar cobertura
                </button>
              </div>
              <div style={{ fontSize: '0.92rem', color: '#6b7280', marginTop: '4px' }}>
                {coveragePlans.length > 0 ? `${coveragePlans.length} cobertura(s) configurada(s).` : 'Sin coberturas configuradas todavía.'}
              </div>
              <div style={{ display: 'grid', gap: '12px', marginTop: '14px' }}>
                {coveragePlans.map((plan) => (
                  <div key={plan.id} style={{ padding: '16px', background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: '12px' }}>
                    <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500' }}>Precio de cobertura</label>
                    <input type="number" min="0" step="1" value={plan.price} onChange={(e) => updateServicePlan(plan.id, 'price', e.target.value)} placeholder="Ej: 80000" style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: '6px', fontSize: '1rem', boxSizing: 'border-box', transition: 'all 0.2s' }} />
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}>
                      <button type="button" onClick={() => removeServicePlan(plan.id)} style={{ padding: '8px 12px', background: '#fee2e2', color: '#991b1b', border: 'none', borderRadius: '999px', cursor: 'pointer', fontWeight: '600' }}>
                        Quitar plan
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
        <button
          onClick={saveAdminSettings}
          disabled={savingSettings}
          style={{
            width: '100%',
            padding: '12px',
            background: '#111827',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            fontSize: '1rem',
            fontWeight: '600',
            cursor: savingSettings ? 'not-allowed' : 'pointer',
            opacity: savingSettings ? 0.6 : 1,
            transition: 'all 0.2s',
          }}
        >
          {savingSettings ? 'Guardando...' : 'Guardar configuracion'}
        </button>

        {uploadStatus && (
          <div
            className="status-message"
            style={{
              marginTop: '14px',
              padding: '12px 14px',
              borderRadius: '10px',
              background: uploadStatus.type === 'success' ? '#d4edda' : '#f8d7da',
              color: uploadStatus.type === 'success' ? '#155724' : '#721c24',
              border: `1px solid ${uploadStatus.type === 'success' ? '#c3e6cb' : '#f5c6cb'}`,
            }}
          >
            <p style={{ margin: 0, fontWeight: 700 }}>{uploadStatus.message}</p>
            {uploadStatus.details && uploadStatus.details.length > 0 && (
              <ul style={{ margin: '8px 0 0', paddingLeft: '20px', fontSize: '0.9rem' }}>
                {uploadStatus.details.map((detail, i) => (
                  <li key={i}>{detail}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div style={{ background: '#f9f9f9', padding: '24px', borderRadius: '12px', marginBottom: '30px', border: '1px solid #eee' }}>
        <h3 style={{ marginTop: '0', marginBottom: '16px', fontSize: '1.2rem' }}>Subir imagenes</h3>

        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500' }}>Seleccionar imagenes</label>
          <input
            type="file"
            multiple
            accept="image/*"
            disabled={loading}
            onChange={handleFileSelect}
            style={{ width: '100%', padding: '12px', boxSizing: 'border-box' }}
          />
          {selectedFiles.length > 0 && (
            <p style={{ margin: '8px 0 0', fontSize: '0.9rem', color: '#666' }}>{selectedFiles.length} archivo(s) seleccionados</p>
          )}
        </div>

        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500' }}>Evento / titulo</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Ej: Boda Juan, Concierto 2024"
            style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: '6px', fontSize: '1rem', boxSizing: 'border-box', transition: 'all 0.2s' }}
          />
        </div>

          <div style={{ marginBottom: '16px' }}>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: '500' }}>Categoria</label>
            <select
              value={categoryPreset}
              onChange={(e) => setCategoryPreset(e.target.value)}
              style={{ width: '100%', padding: '10px', border: '1px solid #ddd', borderRadius: '6px', fontSize: '1rem', boxSizing: 'border-box', background: '#fff' }}
            >
              {CATEGORY_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            {categoryPreset === 'Personalizada' && (
              <input
                type="text"
                value={customCategory}
                onChange={(e) => setCustomCategory(e.target.value)}
                placeholder="Escribe una categoria propia"
                style={{ width: '100%', marginTop: '10px', padding: '10px', border: '1px solid #ddd', borderRadius: '6px', fontSize: '1rem', boxSizing: 'border-box', transition: 'all 0.2s' }}
              />
            )}
          </div>

        <div style={{ marginBottom: '20px', display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={isPortfolio} onChange={(e) => setIsPortfolio(e.target.checked)} style={{ marginRight: '8px', cursor: 'pointer' }} />
            <span>Portfolio (visible publicamente)</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={isForSale} onChange={(e) => setIsForSale(e.target.checked)} style={{ marginRight: '8px', cursor: 'pointer' }} />
            <span>En venta (se puede comprar en la tienda)</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={isFeatured} onChange={(e) => setIsFeatured(e.target.checked)} style={{ marginRight: '8px', cursor: 'pointer' }} />
            <span>Destacada (resaltada)</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={isCategoryCover} onChange={(e) => setIsCategoryCover(e.target.checked)} style={{ marginRight: '8px', cursor: 'pointer' }} />
            <span>Usar como portada de categoria</span>
          </label>
        </div>

        <button
          onClick={uploadImages}
          disabled={selectedFiles.length === 0 || loading}
          style={{
            width: '100%',
            padding: '12px',
            background: '#4CAF50',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            fontSize: '1rem',
            fontWeight: '600',
            cursor: selectedFiles.length === 0 || loading ? 'not-allowed' : 'pointer',
            opacity: selectedFiles.length === 0 || loading ? 0.6 : 1,
            transition: 'all 0.2s',
          }}
        >
          {loading ? uploadProgress?.phase || 'Subiendo...' : 'Subir'}
        </button>

        {uploadProgress && (
          <div
            style={{
              marginTop: '14px',
              padding: '12px',
              border: '1px solid #eee',
              borderRadius: '10px',
              background: '#fff',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: '12px',
                fontSize: '0.9rem',
                marginBottom: '8px',
                color: '#444',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {uploadProgress.currentFile || 'Preparando archivos...'}
              </span>
              <span>
                {uploadProgress.completed}/{uploadProgress.total}
              </span>
            </div>

            <div
              style={{
                height: '8px',
                background: '#e5e7eb',
                borderRadius: '999px',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${uploadProgress.percent}%`,
                  height: '100%',
                  borderRadius: '999px',
                  background: '#4CAF50',
                  transition: 'width 0.2s ease',
                }}
              />
            </div>

            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: '12px',
                marginTop: '8px',
                fontSize: '0.82rem',
                color: '#666',
              }}
            >
              <span>{uploadProgress.success} correctas</span>
              <span>{uploadProgress.failed} fallidas</span>
              <span>{uploadProgress.active} activas</span>
            </div>
          </div>
        )}
      </div>

      <div>
        <h3 style={{ marginBottom: '16px', fontSize: '1.2rem' }}>Imagenes actuales ({images.length})</h3>
        {fetching ? (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: '#999' }}>Cargando imagenes...</div>
        ) : images.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: '#999' }}>Todavia no hay imagenes cargadas</div>
        ) : expandedCategory && activeCategoryGroup ? (
          <div className="admin-category-block">
            <div className="admin-gallery-toolbar">
              <div>
                <button
                  type="button"
                  className="admin-gallery-back"
                  onClick={() => {
                    setExpandedCategory(null);
                    setExpandedAlbumKey(null);
                    setPreviewIndex(null);
                  }}
                >
                  Volver a categorias
                </button>
                <h4 className="admin-gallery-title" style={{ marginTop: '12px' }}>
                  {activeCategoryGroup.name}
                </h4>
              </div>
              <span className="admin-category-count">
                {activeCategoryGroup.albums.length} album(es)
              </span>
            </div>

            {!expandedAlbumKey ? (
              <div className="admin-album-browser">
                {activeCategoryGroup.albums.map((album) => {
                  const coverImage = album.cover || album.images[0] || null;

                  return (
                    <div
                      key={album.key}
                      className="admin-album-card"
                      role="button"
                      tabIndex={0}
                      onClick={() => openAlbum(album.key)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          openAlbum(album.key);
                        }
                      }}
                    >
                      <img src={coverImage?.url} alt={album.title} loading="lazy" />
                      <div className="admin-album-card-body">
                        <h4 className="admin-album-card-title">{album.title}</h4>
                        <div className="admin-album-card-meta">
                          <div>{album.category}</div>
                          <div>{album.images.length} foto(s)</div>
                        </div>
                      </div>
                      <div className="admin-album-card-actions">
                        <button
                          type="button"
                          className="admin-album-delete"
                          onClick={(event) => {
                            event.stopPropagation();
                            requestAlbumDelete(album);
                          }}
                        >
                          Eliminar album
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : activeAlbumGroup ? (
              <>
                <div className="admin-gallery-toolbar">
                  <div>
                    <button
                      type="button"
                      className="admin-gallery-back"
                      onClick={returnToAlbumBrowser}
                    >
                      Volver a albums
                    </button>
                    <h4 className="admin-gallery-title" style={{ marginTop: '12px' }}>
                      {activeAlbumGroup.title}
                    </h4>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                    <span className="admin-category-count">
                      {activeAlbumGroup.images.length} foto(s)
                    </span>
                    {activeAlbumGroup.images.length > 0 && (
                      <button

   type="button"

   onClick={() => showAllInPortfolio(activeAlbumGroup.images)}

   disabled={bulkUpdating}

   style={{

     border: 'none',

     borderRadius: '9999px',

     padding: '8px 12px',

     fontSize: '0.8rem',

     fontWeight: '600',

     cursor: bulkUpdating ? 'not-allowed' : 'pointer',

     background: bulkUpdating ? '#9ca3af' : '#0ea5e9',

     color: '#fff',

   }}

 >

   {bulkUpdating ? 'Aplicando...' : 'Mostrar todas en portfolio'}

 </button>
                    )}

                    {activeAlbumGroup.images.length > 0 && (

                    <button
                        type="button"
                        onClick={() => hideAllFromPortfolio(activeAlbumGroup.images)}
                        disabled={bulkUpdating}
                        style={{
                          border: 'none',
                          borderRadius: '999px',
                          padding: '8px 12px',
                          fontSize: '0.8rem',
                          fontWeight: '600',
                          cursor: bulkUpdating ? 'not-allowed' : 'pointer',
                          background: bulkUpdating ? '#9ca3af' : '#16a34a',
                          color: '#fff',
                        }}
                      >
                        {bulkUpdating ? 'Quitando...' : 'Quitar todas del portfolio'}
                      </button>
                    )}
                    {activeAlbumGroup.images.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setAllForSale(activeAlbumGroup.images, true)}
                        disabled={bulkUpdating}
                        style={{
                          border: 'none',
                          borderRadius: '999px',
                          padding: '8px 12px',
                          fontSize: '0.8rem',
                          fontWeight: '600',
                          cursor: bulkUpdating ? 'not-allowed' : 'pointer',
                          background: bulkUpdating ? '#9ca3af' : '#2563eb',
                          color: '#fff',
                        }}
                      >
                        {bulkUpdating ? 'Aplicando...' : 'Poner todas en venta'}
                      </button>
                    )}
                    {activeAlbumGroup.images.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setAllForSale(activeAlbumGroup.images, false)}
                        disabled={bulkUpdating}
                        style={{
                          border: 'none',
                          borderRadius: '999px',
                          padding: '8px 12px',
                          fontSize: '0.8rem',
                          fontWeight: '600',
                          cursor: bulkUpdating ? 'not-allowed' : 'pointer',
                          background: bulkUpdating ? '#9ca3af' : '#6b7280',
                          color: '#fff',
                        }}
                      >
                        {bulkUpdating ? 'Aplicando...' : 'Quitar todas de venta'}
                      </button>
                    )}
                  </div>
                </div>

                <div className="admin-images-grid">
                  {activeAlbumGroup.images.map((img) => (
                    <div key={img.id} className="admin-image-card">
                      <button
                        type="button"
                        className="admin-image-preview-button"
                        onClick={() =>
                          setPreviewIndex(
                            activeAlbumGroup.images.findIndex((image) => image.id === img.id)
                          )
                        }
                      >
                        <img
                          src={img.url}
                          alt={img.label}
                          loading="lazy"
                          style={{
                            width: '100%',
                            height: '160px',
                            objectFit: 'cover',
                            display: 'block',
                          }}
                        />
                      </button>
                      <div
                        style={{
                          padding: '10px',
                          background: '#fff',
                          fontSize: '0.8rem',
                          minHeight: '40px',
                          display: 'flex',
                          flexDirection: 'column',
                          justifyContent: 'center',
                        }}
                      >
                        <div
                          style={{
                            fontWeight: '600',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {img.label || 'No label'}
                        </div>
                        <div style={{ color: '#999', marginTop: '4px' }}>
                          {img.isPortfolio && <span>Portfolio </span>}
                          {img.isForSale !== false && <span>En venta </span>}
                          {img.isFeatured && <span>Destacada </span>}
                          {img.isCategoryCover && <span>Portada </span>}
                        </div>
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '10px' }}>
                          <button
                            type="button"
                            onClick={() => togglePortfolioImage(img)}
                            disabled={updatingImageId === img.id}
                            style={{
                              border: 'none',
                              borderRadius: '999px',
                              padding: '6px 8px',
                              fontSize: '0.72rem',
                              fontWeight: '600',
                              cursor: updatingImageId === img.id ? 'not-allowed' : 'pointer',
                              background: img.isPortfolio ? '#16a34a' : '#e5e7eb',
                              color: img.isPortfolio ? '#fff' : '#111827',
                            }}
                          >
                            {img.isPortfolio ? 'Ocultar del portfolio' : 'Mostrar en portfolio'}
                          </button>
                          <button
                            type="button"
                            onClick={() => toggleForSaleImage(img)}
                            disabled={updatingImageId === img.id}
                            style={{
                              border: 'none',
                              borderRadius: '999px',
                              padding: '6px 8px',
                              fontSize: '0.72rem',
                              fontWeight: '600',
                              cursor: updatingImageId === img.id ? 'not-allowed' : 'pointer',
                              background: img.isForSale === false ? '#e5e7eb' : '#2563eb',
                              color: img.isForSale === false ? '#111827' : '#fff',
                            }}
                          >
                            {img.isForSale === false ? 'Poner en venta' : 'Quitar de venta'}
                          </button>
                          {img.category && (
                            <button
                              type="button"
                              onClick={() => setCategoryCover(img)}
                              disabled={updatingImageId === img.id}
                              style={{
                                border: 'none',
                                borderRadius: '999px',
                                padding: '6px 8px',
                                fontSize: '0.72rem',
                                fontWeight: '600',
                                cursor: updatingImageId === img.id ? 'not-allowed' : 'pointer',
                                background: img.isCategoryCover ? '#111827' : '#e5e7eb',
                                color: img.isCategoryCover ? '#fff' : '#111827',
                              }}
                            >
                              {img.isCategoryCover ? 'Portada actual' : 'Marcar portada'}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => toggleFeaturedImage(img)}
                            disabled={updatingImageId === img.id}
                            style={{
                              border: 'none',
                              borderRadius: '999px',
                              padding: '6px 8px',
                              fontSize: '0.72rem',
                              fontWeight: '600',
                              cursor: updatingImageId === img.id ? 'not-allowed' : 'pointer',
                              background: img.isFeatured ? '#facc15' : '#e5e7eb',
                              color: '#111827',
                            }}
                          >
                            {img.isFeatured ? 'Quitar destacado' : 'Marcar destacado'}
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteImage(img)}
                            disabled={updatingImageId === img.id}
                            style={{
                              border: 'none',
                              borderRadius: '999px',
                              padding: '6px 8px',
                              fontSize: '0.72rem',
                              fontWeight: '600',
                              cursor: updatingImageId === img.id ? 'not-allowed' : 'pointer',
                              background: '#fee2e2',
                              color: '#991b1b',
                            }}
                          >
                            Eliminar
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        ) : (
          <div className="admin-category-browser">
            {groupedImages.map((group) => (
              <button
                key={group.name}
                type="button"
                className="admin-category-card"
                onClick={() => {
                  setExpandedCategory(group.name);
                  setExpandedAlbumKey(null);
                  setPreviewIndex(null);
                }}
              >
                <img src={group.images[0]?.url} alt={group.name} loading="lazy" />
                <div className="admin-category-card-body">
                  <h4 className="admin-category-card-title">{group.name}</h4>
                  <div className="admin-category-card-meta">
                    {group.images.length} imagen(es)
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {previewImage && (
        <div className="admin-preview-overlay" onClick={() => setPreviewIndex(null)}>
          <div className="admin-preview-modal" onClick={(event) => event.stopPropagation()}>
            <div className="admin-preview-image-wrap">
              <button
                type="button"
                className="admin-preview-nav admin-preview-nav-left"
                onClick={goToPreviousPreview}
              >
                {'<'}
              </button>
              <img
                src={previewImage.url}
                alt={previewImage.label || 'Vista previa'}
                className="admin-preview-image"
              />
              <button
                type="button"
                className="admin-preview-nav admin-preview-nav-right"
                onClick={goToNextPreview}
              >
                {'>'}
              </button>
            </div>
            <div className="admin-preview-body">
              <div className="admin-preview-top">
                <div>
                  <div style={{ fontSize: '1rem', fontWeight: '700', color: '#111827' }}>
                    {previewImage.label || 'Sin titulo'}
                  </div>
                  <div style={{ marginTop: '6px', color: '#6b7280', fontSize: '0.9rem' }}>
                    {previewImage.category || 'Sin categoria'}
                    {activeAlbumGroup
                      ? ` Â· ${previewIndex + 1} de ${activeAlbumGroup.images.length}`
                      : ''}
                  </div>
                </div>
                <button
                  type="button"
                  className="admin-preview-close"
                  onClick={() => setPreviewIndex(null)}
                >
                  Cerrar
                </button>
              </div>

              <div className="admin-preview-mobile-nav">
                <button
                  type="button"
                  className="ghost-button"
                  style={{ flex: 1 }}
                  onClick={goToPreviousPreview}
                >
                  Anterior
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  style={{ flex: 1 }}
                  onClick={goToNextPreview}
                >
                  Siguiente
                </button>
              </div>

              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={() => togglePortfolioImage(previewImage)}
                  disabled={updatingImageId === previewImage.id}
                  style={{
                    border: 'none',
                    borderRadius: '999px',
                    padding: '8px 12px',
                    fontSize: '0.8rem',
                    fontWeight: '600',
                    cursor: updatingImageId === previewImage.id ? 'not-allowed' : 'pointer',
                    background: previewImage.isPortfolio ? '#16a34a' : '#e5e7eb',
                    color: previewImage.isPortfolio ? '#fff' : '#111827',
                  }}
                >
                  {previewImage.isPortfolio ? 'Ocultar del portfolio' : 'Mostrar en portfolio'}
                </button>
                <button
                  type="button"
                  onClick={() => toggleForSaleImage(previewImage)}
                  disabled={updatingImageId === previewImage.id}
                  style={{
                    border: 'none',
                    borderRadius: '999px',
                    padding: '8px 12px',
                    fontSize: '0.8rem',
                    fontWeight: '600',
                    cursor: updatingImageId === previewImage.id ? 'not-allowed' : 'pointer',
                    background: previewImage.isForSale === false ? '#e5e7eb' : '#2563eb',
                    color: previewImage.isForSale === false ? '#111827' : '#fff',
                  }}
                >
                  {previewImage.isForSale === false ? 'Poner en venta' : 'Quitar de venta'}
                </button>
                {previewImage.category && (
                  <button
                    type="button"
                    onClick={() => setCategoryCover(previewImage)}
                    disabled={updatingImageId === previewImage.id}
                    style={{
                      border: 'none',
                      borderRadius: '999px',
                      padding: '8px 12px',
                      fontSize: '0.8rem',
                      fontWeight: '600',
                      cursor: updatingImageId === previewImage.id ? 'not-allowed' : 'pointer',
                      background: previewImage.isCategoryCover ? '#111827' : '#e5e7eb',
                      color: previewImage.isCategoryCover ? '#fff' : '#111827',
                    }}
                  >
                    {previewImage.isCategoryCover ? 'Portada actual' : 'Marcar portada'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => toggleFeaturedImage(previewImage)}
                  disabled={updatingImageId === previewImage.id}
                  style={{
                    border: 'none',
                    borderRadius: '999px',
                    padding: '8px 12px',
                    fontSize: '0.8rem',
                    fontWeight: '600',
                    cursor: updatingImageId === previewImage.id ? 'not-allowed' : 'pointer',
                    background: previewImage.isFeatured ? '#facc15' : '#e5e7eb',
                    color: '#111827',
                  }}
                >
                  {previewImage.isFeatured ? 'Quitar destacado' : 'Marcar destacado'}
                </button>
                <button
                  type="button"
                  onClick={() => deleteImage(previewImage, { keepPreviewOpen: true })}
                  disabled={updatingImageId === previewImage.id}
                  style={{
                    border: 'none',
                    borderRadius: '999px',
                    padding: '8px 12px',
                    fontSize: '0.8rem',
                    fontWeight: '600',
                    cursor: updatingImageId === previewImage.id ? 'not-allowed' : 'pointer',
                    background: '#fee2e2',
                    color: '#991b1b',
                  }}
                >
                  Eliminar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {pendingAlbumDelete && (
        <div className="admin-delete-overlay" onClick={() => setPendingAlbumDelete(null)}>
          <div className="admin-delete-modal" onClick={(event) => event.stopPropagation()}>
            <h4 className="admin-delete-title">Eliminar album completo?</h4>
            <div className="admin-delete-body">
              <div style={{ fontWeight: 700, color: '#111827' }}>{pendingAlbumDelete.title}</div>
              <div style={{ marginTop: '4px' }}>{pendingAlbumDelete.category}</div>
              <div style={{ marginTop: '10px' }}>
                Este album contiene {pendingAlbumDelete.images.length} foto(s).
                Se eliminaran todos los documentos y las imagenes asociadas.
              </div>
            </div>
            <div className="admin-delete-actions">
              <button
                type="button"
                className="admin-delete-cancel"
                onClick={() => setPendingAlbumDelete(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="admin-delete-confirm"
                onClick={confirmAlbumDelete}
              >
                Eliminar album
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
