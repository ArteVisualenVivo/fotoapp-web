import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { getDoc, getDocs } from 'firebase/firestore';
import { getAdminSettingsRef, getPublicPhotosQuery, getShopPhotosQuery, normalizeLabel, normalizePhoto } from './firebase';

const DEFAULT_WHATSAPP_MESSAGE = 'Hola, quiero consultar por estas fotos:';
const DEFAULT_CONTACT_EMAIL = 'cesardarioph@gmail.com';
const DEFAULT_LOCATION = 'Cordoba, Argentina';
const DEFAULT_PRICING_TITLE = 'Servicios y precios';
const DEFAULT_PRICING_BODY =
  'Sesiones personalizadas, cobertura de eventos y entregas editadas. Consulta disponibilidad y presupuesto segun tu proyecto.';
const MODAL_BLUR = 'blur(2px)';
const MOBILE_BREAKPOINT = '(max-width: 780px)';
const PRICE_FORMATTER = new Intl.NumberFormat('es-AR', {
  maximumFractionDigits: 0,
});
const INSTAGRAM_LINKS = [
  {
    href: 'https://www.instagram.com/cesardario_ph?utm_source=qr&igsh=d2Q0Nm13cDJrNHM0',
    label: '@cesardario_ph',
  },
  {
    href: 'https://www.instagram.com/artevisualenvivo?utm_source=qr&igsh=NndiZG05czlnZ2Vs',
    label: '@artevisualenvivo',
  },
];

function getCreatedAtValue(image) {
  return image?.createdAt?.seconds || 0;
}

function sortImagesByNewest(images) {
  return [...images].sort((a, b) => getCreatedAtValue(b) - getCreatedAtValue(a));
}

function thumbSrc(photo) {
  return photo?.thumbUrl || photo?.url || '';
}

function formatMoney(amount) {
  if (!Number.isFinite(amount) || amount <= 0) {
    return '';
  }

  return `$ ${PRICE_FORMATTER.format(Math.round(amount))}`;
}

function parseMoneyValue(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  const raw = `${value ?? ''}`.trim();
  if (!raw) return null;

  const normalized = raw.replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function getPricingPlanLabel(plan) {
  const type = normalizeLabel(plan?.type || '').trim();
  const customType = normalizeLabel(plan?.customType || '').trim();

  if (type.toLowerCase() === 'personalizado') {
    return customType || type || '';
  }

  return type || customType || '';
}

function getPricingPlanKind(plan) {
  const explicitKind = `${plan?.planKind ?? plan?.pricingKind ?? ''}`.trim().toLowerCase();
  if (explicitKind === 'individual' || explicitKind === 'pack' || explicitKind === 'coverage') {
    return explicitKind;
  }

  const label = getPricingPlanLabel(plan).toLowerCase();

  if (!label) return 'coverage';
  if (label === 'individual' || label.includes('individual')) return 'individual';
  if (label.includes('pack')) return 'pack';
  if (label.includes('cobertur')) return 'coverage';

  return 'coverage';
}

function getPricingPlanSize(plan) {
  const explicitSize = Number(plan?.packSize || plan?.bundleSize || plan?.minPhotos || plan?.maxPhotos);
  if (Number.isFinite(explicitSize) && explicitSize > 0) {
    return explicitSize;
  }

  const label = getPricingPlanLabel(plan).toLowerCase();
  const match = label.match(/pack\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

function buildPricingPlanCatalog(servicePlans) {
  return (Array.isArray(servicePlans) ? servicePlans : [])
    .map((plan, index) => {
      const label = getPricingPlanLabel(plan);
      const amount = parseMoneyValue(plan?.price);
      const kind = getPricingPlanKind(plan);
      const packSize = kind === 'pack' ? getPricingPlanSize(plan) : null;

      return {
        ...plan,
        id: plan?.id || `pricing-plan-${index}`,
        label,
        amount,
        priceText: `${plan?.price ?? ''}`.trim(),
        description: `${plan?.description ?? ''}`.trim(),
        kind,
        packSize,
        enabled: plan?.enabled !== false,
      };
    })
    .filter((plan) => plan.enabled && plan.label && Number.isFinite(plan.amount) && plan.amount > 0);
}

function chooseLowestPricePlan(plans) {
  return [...plans].sort((a, b) => {
    if (a.amount !== b.amount) return a.amount - b.amount;
    if ((a.packSize || 1) !== (b.packSize || 1)) return (b.packSize || 1) - (a.packSize || 1);
    return a.label.localeCompare(b.label, 'es');
  })[0] || null;
}

function buildPricingRecommendation(selectedCount, individualPlan, packPlans) {
  if (selectedCount <= 0 || (!individualPlan && packPlans.length === 0)) {
    return null;
  }

  const catalog = [];
  if (individualPlan) {
    catalog.push({
      key: 'individual',
      label: individualPlan.label,
      amount: individualPlan.amount,
      size: 1,
      source: individualPlan,
    });
  }

  packPlans.forEach((plan) => {
    if (!plan.packSize) return;
    catalog.push({
      key: plan.id,
      label: plan.label,
      amount: plan.amount,
      size: plan.packSize,
      source: plan,
    });
  });

  if (catalog.length === 0) return null;

  const dp = Array.from({ length: selectedCount + 1 }, () => null);
  dp[0] = {
    cost: 0,
    steps: 0,
    largestPackSize: 0,
    counts: catalog.map(() => 0),
  };

  for (let count = 1; count <= selectedCount; count += 1) {
    let best = null;

    for (let index = 0; index < catalog.length; index += 1) {
      const plan = catalog[index];
      if (count < plan.size) continue;

      const prev = dp[count - plan.size];
      if (!prev) continue;

      const nextCounts = prev.counts.slice();
      nextCounts[index] += 1;
      const candidate = {
        cost: prev.cost + plan.amount,
        steps: prev.steps + 1,
        largestPackSize: Math.max(prev.largestPackSize, plan.size),
        counts: nextCounts,
      };

      if (
        !best ||
        candidate.cost < best.cost ||
        (candidate.cost === best.cost && candidate.steps < best.steps) ||
        (candidate.cost === best.cost &&
          candidate.steps === best.steps &&
          candidate.largestPackSize > best.largestPackSize)
      ) {
        best = candidate;
      }
    }

    dp[count] = best;
  }

  const finalResult = dp[selectedCount];
  if (!finalResult) return null;

  const selectedPlans = catalog
    .map((plan, index) => ({
      ...plan,
      count: finalResult.counts[index] || 0,
    }))
    .filter((plan) => plan.count > 0);

  const individualBase = individualPlan ? selectedCount * individualPlan.amount : null;
  const savings = individualBase !== null ? Math.max(0, individualBase - finalResult.cost) : null;

  return {
    selectedCount,
    estimatedTotal: finalResult.cost,
    individualBase,
    savings,
    selectedPlans,
  };
}

function formatPricingPlanName(plan) {
  if (!plan) return '';

  if (plan.size === 1) {
    return 'Individual';
  }

  return plan.label || `Pack ${plan.size}`;
}

function buildPricingSummaryText(recommendation) {
  if (!recommendation || recommendation.selectedPlans.length === 0) {
    return '';
  }

  return recommendation.selectedPlans
    .map((plan) => `${plan.count} x ${formatPricingPlanName(plan)}`)
    .join(' + ');
}

function parseAlbumLabel(label) {
  const rawLabel = normalizeLabel(label);
  const parts = rawLabel
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    return {
      hasHierarchy: true,
      parentTitle: parts[0],
      childTitle: parts.slice(1).join(' | '),
      rawLabel,
    };
  }

  return {
    hasHierarchy: false,
    parentTitle: '',
    childTitle: rawLabel,
    rawLabel,
  };
}

function groupByCategoryAndEvent(images) {
  const grouped = new Map();

  for (const image of images) {
    const categoryName = image.category?.trim() || 'General';
    const parsedLabel = parseAlbumLabel(image.label);
    const albumKey = parsedLabel.hasHierarchy
      ? `${parsedLabel.parentTitle}::${parsedLabel.childTitle}`
      : parsedLabel.childTitle || image.id;

    const categoryEntry = grouped.get(categoryName) || {
      name: categoryName,
      images: [],
      cover: null,
      featuredCount: 0,
      albumsMap: new Map(),
    };

    categoryEntry.images.push(image);
    if (image.isFeatured) categoryEntry.featuredCount += 1;
    if (image.isCategoryCover && !categoryEntry.cover) categoryEntry.cover = image;

    const albumEntry = categoryEntry.albumsMap.get(albumKey) || {
      key: albumKey,
      title: parsedLabel.childTitle,
      parentTitle: parsedLabel.parentTitle,
      rawLabel: parsedLabel.rawLabel,
      hasHierarchy: parsedLabel.hasHierarchy,
      images: [],
      cover: null,
      featuredCount: 0,
    };

    albumEntry.images.push(image);
    if (image.isFeatured) albumEntry.featuredCount += 1;
    if (image.isCategoryCover && !albumEntry.cover) albumEntry.cover = image;
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
            title: album.title || sortedImages[0]?.label || entry.name,
            images: sortedImages,
            cover:
              album.cover ||
              sortedImages.find((img) => img.isFeatured) ||
              sortedImages[0] ||
              null,
          };
        })
        .sort((a, b) => {
          const aTime = getCreatedAtValue(a.images[0]);
          const bTime = getCreatedAtValue(b.images[0]);
          if (bTime !== aTime) return bTime - aTime;
          return a.title.localeCompare(b.title, 'es');
        });

      const parentGroupsMap = new Map();
      const directAlbums = [];

      for (const album of albums) {
        if (!album.hasHierarchy || !album.parentTitle) {
          directAlbums.push(album);
          continue;
        }

        const parentEntry = parentGroupsMap.get(album.parentTitle) || {
          key: album.parentTitle,
          title: album.parentTitle,
          albums: [],
          images: [],
          cover: null,
        };

        parentEntry.albums.push(album);
        parentEntry.images.push(...album.images);
        if (!parentEntry.cover) {
          parentEntry.cover = album.cover || album.images[0] || null;
        }
        parentGroupsMap.set(album.parentTitle, parentEntry);
      }

      const parentGroups = Array.from(parentGroupsMap.values())
        .map((group) => {
          const sortedAlbums = group.albums.sort((a, b) => {
            const aTime = getCreatedAtValue(a.images[0]);
            const bTime = getCreatedAtValue(b.images[0]);
            if (bTime !== aTime) return bTime - aTime;
            return a.title.localeCompare(b.title, 'es');
          });

          return {
            ...group,
            albums: sortedAlbums,
            images: sortImagesByNewest(group.images),
            cover:
              group.cover ||
              sortedAlbums.find((album) => album.cover)?.cover ||
              sortedAlbums[0]?.cover ||
              sortedAlbums[0]?.images[0] ||
              null,
          };
        })
        .sort((a, b) => a.title.localeCompare(b.title, 'es'));

      const sortedImages = sortImagesByNewest(entry.images);

      return {
        ...entry,
        albums,
        parentGroups,
        directAlbums,
        images: sortedImages,
        cover:
          entry.cover ||
          parentGroups.find((group) => group.cover)?.cover ||
          directAlbums.find((album) => album.cover)?.cover ||
          albums.find((album) => album.cover)?.cover ||
          sortedImages.find((img) => img.isFeatured) ||
          sortedImages[0] ||
          null,
      };
    })
    .sort((a, b) => {
      const aTime = getCreatedAtValue(a.images[0]);
      const bTime = getCreatedAtValue(b.images[0]);
      if (bTime !== aTime) return bTime - aTime;
      return a.name.localeCompare(b.name, 'es');
    });
}

function ImageSkeleton({ height = 280 }) {
  return (
    <div
      style={{
        width: '100%',
        height,
        borderRadius: '24px',
        background:
          'linear-gradient(135deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03), rgba(255,255,255,0.06))',
        animation: 'pulse 1.4s ease-in-out infinite',
      }}
    />
  );
}

export default function Portfolio() {
  const [images, setImages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalIndex, setModalIndex] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [selectedParentGroup, setSelectedParentGroup] = useState(null);
  const [selectedAlbumKey, setSelectedAlbumKey] = useState(null);
  const [selectedPhotoIds, setSelectedPhotoIds] = useState([]);
  const [whatsAppNumber, setWhatsAppNumber] = useState('');
  const [adminName, setAdminName] = useState('');
  const [contactEmail, setContactEmail] = useState(DEFAULT_CONTACT_EMAIL);
  const [location, setLocation] = useState(DEFAULT_LOCATION);
  const [salesPageUrl, setSalesPageUrl] = useState('');
  const [whatsAppMessage, setWhatsAppMessage] = useState(DEFAULT_WHATSAPP_MESSAGE);
  const [servicePlans, setServicePlans] = useState([]);
  const [isContactOpen, setIsContactOpen] = useState(false);
  const [contactDraft, setContactDraft] = useState('');
  const visibleName = '';
  const [heroCoverIndex, setHeroCoverIndex] = useState(0);
  const [heroCategoryKey, setHeroCategoryKey] = useState(null);
  const [heroSlideState, setHeroSlideState] = useState({
    animating: false,
    from: 0,
    to: 0,
  });
  const contactPopoverRef = useRef(null);
  const contactToggleRef = useRef(null);
  const heroCoverIndexRef = useRef(0);
  const heroSlideTimeoutRef = useRef(null);

  useEffect(() => {
    const fetchPortfolio = async () => {
      setLoading(true);
      try {
        const [snapshot, settingsSnapshot] = await Promise.all([
          getDocs(getShopPhotosQuery()),
          getDoc(getAdminSettingsRef()),
        ]);

        const docs = snapshot.docs
          .map((docItem) => normalizePhoto(docItem.id, docItem.data()))
          .filter((img) => Boolean(img.url))
          .filter((img) => img.isForSale !== false);

        setImages(docs);

        if (settingsSnapshot.exists()) {
          const settings = settingsSnapshot.data();
          setWhatsAppNumber(settings.whatsappNumber || '');
          setAdminName(settings.adminName || '');
          setContactEmail(settings.contactEmail || DEFAULT_CONTACT_EMAIL);
          setLocation(settings.location || DEFAULT_LOCATION);
          setSalesPageUrl(settings.salesPageUrl || '');
          setWhatsAppMessage(settings.whatsappMessage || DEFAULT_WHATSAPP_MESSAGE);
          setServicePlans(Array.isArray(settings.servicePlans) ? settings.servicePlans : []);
        }
      } catch (error) {
        console.error('Error fetching photos:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchPortfolio();
  }, []);

  useEffect(() => {
    const blockContextMenu = (event) => {
      event.preventDefault();
    };

    const blockShortcuts = (event) => {
      const key = event.key?.toLowerCase();
      const isSaveShortcut = (event.ctrlKey || event.metaKey) && key === 's';
      const isDevtoolsShortcut =
        key === 'f12' ||
        ((event.ctrlKey || event.metaKey) &&
          event.shiftKey &&
          ['i', 'j', 'c', 's'].includes(key)) ||
        ((event.ctrlKey || event.metaKey) && key === 'u');

      if (isSaveShortcut || isDevtoolsShortcut || key === 'printscreen') {
        event.preventDefault();
      }
    };

    document.addEventListener('contextmenu', blockContextMenu);
    window.addEventListener('keydown', blockShortcuts);

    return () => {
      document.removeEventListener('contextmenu', blockContextMenu);
      window.removeEventListener('keydown', blockShortcuts);
    };
  }, []);

  const categories = useMemo(() => groupByCategoryAndEvent(images), [images]);

  useEffect(() => {
    const baseTitle = 'César Dario — Fotografía en Córdoba | Portfolio';
    document.title = selectedCategory ? selectedCategory + ' — ' + baseTitle : baseTitle;
  }, [selectedCategory]);
  const heroCoverImages = useMemo(() => {
    const covers = images.filter((image) => image.isCategoryCover && image.url);
    const uniqueCovers = [];
    const seenIds = new Set();

    for (const image of covers) {
      if (seenIds.has(image.id)) continue;
      seenIds.add(image.id);
      uniqueCovers.push(image);
    }

    return uniqueCovers;
  }, [images]);
  const heroCategoryOptions = useMemo(() => {
    const optionMap = new Map();

    for (const image of heroCoverImages) {
      const key = normalizeLabel(image.category || 'General').toLowerCase();
      const existing = optionMap.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        optionMap.set(key, {
          key,
          label: image.category?.trim() || 'General',
          count: 1,
        });
      }
    }

    return Array.from(optionMap.values());
  }, [heroCoverImages]);
  const heroCarouselImages = useMemo(() => {
    if (!heroCategoryKey) return heroCoverImages;
    return heroCoverImages.filter((image) => normalizeLabel(image.category || 'General').toLowerCase() === heroCategoryKey);
  }, [heroCoverImages, heroCategoryKey]);
  const activeCategory = useMemo(
    () => categories.find((category) => category.name === selectedCategory) || null,
    [categories, selectedCategory]
  );
  const activeParentGroup = useMemo(
    () => activeCategory?.parentGroups.find((group) => group.title === selectedParentGroup) || null,
    [activeCategory, selectedParentGroup]
  );
  const activeAlbum = useMemo(
    () =>
      (activeParentGroup?.albums || activeCategory?.albums || []).find(
        (album) => album.key === selectedAlbumKey
      ) || null,
    [activeCategory, activeParentGroup, selectedAlbumKey]
  );
  const activeCategoryImages = activeCategory?.images || [];
  const activeAlbumImages = activeAlbum?.images || [];
  const modalImage = modalIndex === null ? null : activeAlbumImages[modalIndex] || null;
  const isGalleryModalOpen = Boolean(activeAlbum);
  const heroCoverImage =
    heroCarouselImages[heroCoverIndex] ||
    heroCarouselImages[0] ||
    heroCoverImages[0] ||
    categories[0]?.cover ||
    images[0] ||
    null;
  const heroCarouselCurrentIndex = heroSlideState.animating ? heroSlideState.from : heroCoverIndex;
  const heroCarouselNextIndex =
    heroCarouselImages.length > 1
      ? (heroCarouselCurrentIndex + 1) % heroCarouselImages.length
      : heroCarouselCurrentIndex;
  const heroCarouselPrevIndex =
    heroCarouselImages.length > 1
      ? (heroCarouselCurrentIndex - 1 + heroCarouselImages.length) % heroCarouselImages.length
      : heroCarouselCurrentIndex;
  const heroCurrentImage = heroCarouselImages[heroCarouselCurrentIndex] || heroCoverImage;
  const heroPrevImage = heroCarouselImages[heroCarouselPrevIndex] || null;
  const heroNextImage =
    heroCarouselImages.length > 1 ? heroCarouselImages[heroCarouselNextIndex] || null : null;
  const selectedPhotos = useMemo(
    () =>
      selectedPhotoIds
        .map((photoId) => images.find((image) => image.id === photoId))
        .filter(Boolean),
    [images, selectedPhotoIds]
  );
  const pricingPlanCatalog = useMemo(
    () => buildPricingPlanCatalog(servicePlans),
    [servicePlans]
  );
  const pricingRecommendation = useMemo(() => {
    const individualPlan =
      pricingPlanCatalog.find((plan) => plan.kind === 'individual') ||
      chooseLowestPricePlan(pricingPlanCatalog.filter((plan) => plan.size === 1));
    const packPlans = pricingPlanCatalog.filter((plan) => plan.kind === 'pack' && plan.packSize > 0);

    return buildPricingRecommendation(selectedPhotoIds.length, individualPlan, packPlans);
  }, [pricingPlanCatalog, selectedPhotoIds.length]);
  const pricingSummaryText = useMemo(
    () => buildPricingSummaryText(pricingRecommendation),
    [pricingRecommendation]
  );
  const serviceShowcaseText = useMemo(() => {
    const descriptions = (Array.isArray(servicePlans) ? servicePlans : [])
      .map((plan) => `${plan?.type || ''} ${plan?.customType || ''}`.trim())
      .filter(Boolean);

    const unique = [...new Set(descriptions)];
    return unique.slice(0, 5).join(' · ');
  }, [servicePlans]);
  const primaryWhatsAppImage = modalImage || activeAlbumImages[0] || activeCategoryImages[0] || images[0] || null;

  useEffect(() => {
    if (heroCategoryOptions.length > 0) {
      if (!heroCategoryKey || !heroCategoryOptions.some((option) => option.key === heroCategoryKey)) {
        setHeroCategoryKey(heroCategoryOptions[0].key);
        setHeroCoverIndex(0);
        heroCoverIndexRef.current = 0;
        setHeroSlideState({ animating: false, from: 0, to: 0 });
      }
      return undefined;
    }

    if (heroCoverImages.length === 0) {
      setHeroCoverIndex(0);
      heroCoverIndexRef.current = 0;
      return undefined;
    }

    if (heroCoverIndex >= heroCarouselImages.length) {
      setHeroCoverIndex(0);
    }
  }, [heroCarouselImages.length, heroCategoryKey, heroCategoryOptions, heroCoverImages.length, heroCoverIndex]);

  useEffect(() => {
    heroCoverIndexRef.current = heroCoverIndex;
  }, [heroCoverIndex]);

  const startHeroSlide = useCallback(() => {
    if (heroCarouselImages.length <= 1) return;
    if (heroSlideTimeoutRef.current) {
      window.clearTimeout(heroSlideTimeoutRef.current);
    }

    const current = heroCoverIndexRef.current;
    const next = (current + 1) % heroCarouselImages.length;

    setHeroSlideState({
      animating: true,
      from: current,
      to: next,
    });

    heroSlideTimeoutRef.current = window.setTimeout(() => {
      setHeroSlideState({
        animating: false,
        from: next,
        to: next,
      });
      heroCoverIndexRef.current = next;
      setHeroCoverIndex(next);
      heroSlideTimeoutRef.current = null;
    }, 700);
  }, [heroCarouselImages.length]);

  useEffect(() => {
    return () => {
      if (heroSlideTimeoutRef.current) {
        window.clearTimeout(heroSlideTimeoutRef.current);
        heroSlideTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (heroCarouselImages.length <= 1 || heroSlideState.animating) return undefined;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;

    const intervalId = window.setInterval(() => {
      startHeroSlide();
    }, 4500);

    return () => window.clearInterval(intervalId);
  }, [heroCarouselImages.length, heroSlideState.animating, startHeroSlide]);

  const goToHeroSlide = (index) => {
    if (heroSlideTimeoutRef.current) {
      window.clearTimeout(heroSlideTimeoutRef.current);
      heroSlideTimeoutRef.current = null;
    }
    heroCoverIndexRef.current = index;
    setHeroCoverIndex(index);
    setHeroSlideState({ animating: false, from: index, to: index });
  };

  const closeModal = useCallback(() => {
    setModalIndex(null);
    setSelectedAlbumKey(null);
  }, []);

  useEffect(() => {
    if (!modalImage) return undefined;

    const handleKeyNavigation = (event) => {
      if (event.key === 'Escape') closeModal();
      if (event.key === 'ArrowRight') {
        setModalIndex((current) => (current + 1) % activeAlbumImages.length);
      }
      if (event.key === 'ArrowLeft') {
        setModalIndex((current) => (current - 1 + activeAlbumImages.length) % activeAlbumImages.length);
      }
    };

    window.addEventListener('keydown', handleKeyNavigation);
    return () => window.removeEventListener('keydown', handleKeyNavigation);
  }, [modalImage, activeAlbumImages.length, closeModal]);

  useEffect(() => {
    if (!isContactOpen) return undefined;

    const handlePointerDown = (event) => {
      const popover = contactPopoverRef.current;
      const toggle = contactToggleRef.current;

      if (
        popover &&
        !popover.contains(event.target) &&
        toggle &&
        !toggle.contains(event.target)
      ) {
        setIsContactOpen(false);
      }
    };

    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setIsContactOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [isContactOpen]);

  useEffect(() => {
    if (!isGalleryModalOpen) return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isGalleryModalOpen]);

  const blockImageInteraction = (event) => {
    event.preventDefault();
  };

  const handleImageError = (url) => {
    console.error('Error loading portfolio image:', url);
  };

  const isPhotoSelected = (photoId) => selectedPhotoIds.includes(photoId);

  const toggleSelectedPhoto = (photo) => {
    if (!photo?.id) return;

    setSelectedPhotoIds((current) =>
      current.includes(photo.id)
        ? current.filter((photoId) => photoId !== photo.id)
        : [...current, photo.id]
    );
  };

  const openCategory = (categoryName) => {
    const targetCategory = categories.find((category) => category.name === categoryName);
    if (!targetCategory) return;

    setSelectedCategory(targetCategory.name);
    setSelectedParentGroup(null);
    setSelectedAlbumKey(null);
    setModalIndex(null);
  };

  const openParentGroup = (parentGroupTitle) => {
    if (!activeCategory) return;

    const targetGroup = activeCategory.parentGroups.find((group) => group.title === parentGroupTitle);
    if (!targetGroup) return;

    setSelectedParentGroup(targetGroup.title);
    setSelectedAlbumKey(null);
    setModalIndex(null);
  };

  const openAlbum = (categoryName, albumKey, parentGroupTitle = null) => {
    setSelectedCategory(categoryName);
    setSelectedParentGroup(parentGroupTitle);
    setSelectedAlbumKey(albumKey);
    setModalIndex(null);
  };

  const returnToPortfolio = useCallback(() => {
    setModalIndex(null);
    setSelectedCategory(null);
    setSelectedParentGroup(null);
    setSelectedAlbumKey(null);
    setIsContactOpen(false);

    window.requestAnimationFrame(() => {
      document.getElementById('portfolio')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
  }, []);

  const handleWhatsAppRequest = (requestedTarget) => {
    if (!whatsAppNumber) return;

    const requestedImages = Array.isArray(requestedTarget)
      ? requestedTarget
      : requestedTarget?.id
        ? [requestedTarget]
        : selectedPhotos.length > 0
          ? selectedPhotos
          : primaryWhatsAppImage
            ? [primaryWhatsAppImage]
            : [];

    if (requestedImages.length === 0) return;

    const cleanNumber = whatsAppNumber.replace(/\D/g, '');
    const categoryList = [...new Set(requestedImages.map((image) => image.category || 'General'))];
    const eventList = [...new Set(requestedImages.map((image) => image.label?.trim()).filter(Boolean))];
    const messageLines = [
      whatsAppMessage || DEFAULT_WHATSAPP_MESSAGE,
      '',
      `Categorias: ${categoryList.join(', ')}`,
      ...(eventList.length > 0 ? [`Eventos: ${eventList.join(', ')}`] : []),
      `Cantidad: ${requestedImages.length} foto(s)`,
      '',
      ...requestedImages.flatMap((image, index) => [
        `${index + 1}. ${image.label || 'Imagen'}${image.category ? ` - ${image.category}` : ''}`,
        image.url || image.originalUrl,
        '',
      ]),
    ];

    if (salesPageUrl) {
      messageLines.push(`Pagina de compra: ${salesPageUrl}`);
    }

    window.open(
      `https://wa.me/${cleanNumber}?text=${encodeURIComponent(messageLines.join('\n'))}`,
      '_blank',
      'noopener,noreferrer'
    );
  };

  const handleContactWhatsApp = () => {
    if (!whatsAppNumber) return;

    const cleanNumber = whatsAppNumber.replace(/\D/g, '');
    const message = contactDraft.trim() || 'Hola, quiero hacer una consulta.';
    window.open(
      `https://wa.me/${cleanNumber}?text=${encodeURIComponent(message)}`,
      '_blank',
      'noopener,noreferrer'
    );
  };

  const handleContactEmail = () => {
    const subject = encodeURIComponent(`Consulta para ${adminName || 'portfolio'}`);
    const body = encodeURIComponent(contactDraft.trim() || 'Hola, quiero hacer una consulta.');
    window.open(`mailto:${contactEmail}?subject=${subject}&body=${body}`, '_self');
  };

  return (
    <div
      style={{
        minHeight: 'auto',
        background:
          'radial-gradient(circle at top, rgba(134, 92, 29, 0.18), transparent 30%), #050505',
        color: '#f5f1ea',
        fontFamily:
          'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      <style>{`

        * { box-sizing: border-box; }
        body { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
        img { -webkit-user-drag: none; user-select: none; }
        html { scroll-behavior: smooth; }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.55; }
        }

        @keyframes floatIn {
          from { opacity: 0; transform: translateY(18px); }
          to { opacity: 1; transform: translateY(0); }
        }

        @keyframes modalIn {
          from { opacity: 0; transform: translateY(12px) scale(0.985); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }

        .portfolio-shell {
          width: 100%;
          max-width: none;
          margin: 0;
          padding: 18px 0 64px;
        }

        .glass-frame {
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 32px;
          background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.015));
          box-shadow: 0 22px 64px rgba(0,0,0,0.3);
          overflow: visible;
          position: relative;
        }

        .top-nav {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 18px;
          padding: 24px 28px;
          border-bottom: 1px solid rgba(255,255,255,0.06);
          backdrop-filter: blur(16px);
          position: relative;
          z-index: 30;
        }

        .brand {
          display: flex;
          align-items: center;
          gap: 16px;
        }

        .brand-mark {
          width: 44px;
          height: 44px;
          border-radius: 14px;
          background: linear-gradient(135deg, #8d672d, #f0d49b);
          display: grid;
          place-items: center;
          color: #120f0a;
          font-weight: 800;
          font-size: 1rem;
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.35);
        }

        .brand-copy strong {
          display: block;
          font-size: 0.96rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }

        .brand-copy span {
          display: block;
          margin-top: 4px;
          font-size: 0.86rem;
          color: rgba(245,241,234,0.6);
        }

        .nav-links {
          display: flex;
          align-items: center;
          gap: 14px;
          flex-wrap: wrap;
        }

        .nav-links a {
          color: rgba(245,241,234,0.76);
          text-decoration: none;
          font-size: 0.92rem;
        }

        .request-button,
        .ghost-button,
        .select-chip,
        .thumb-button {
          transition: transform 220ms ease, box-shadow 220ms ease, opacity 220ms ease, border-color 220ms ease;
        }

        .request-button {
          border: none;
          border-radius: 999px;
          padding: 13px 20px;
          background: linear-gradient(135deg, #1f6b4f, #163d2f);
          color: #effaf4;
          font-weight: 600;
          font-size: 0.92rem;
          cursor: pointer;
          box-shadow: 0 18px 40px rgba(0,0,0,0.24);
        }

        .ghost-button {
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 999px;
          padding: 11px 16px;
          background: rgba(255,255,255,0.04);
          color: rgba(245,241,234,0.9);
          font-weight: 600;
          font-size: 0.9rem;
          cursor: pointer;
        }

        .request-button:hover:not(:disabled),
        .ghost-button:hover:not(:disabled),
        .select-chip:hover:not(:disabled),
        .thumb-button:hover:not(:disabled) {
          transform: translateY(-2px);
          box-shadow: 0 18px 36px rgba(0,0,0,0.22);
        }

        .request-button:disabled,
        .ghost-button:disabled,
        .select-chip:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }

        .nav-contact {
          position: relative;
        }

        .contact-toggle {
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 999px;
          padding: 11px 16px;
          background: rgba(255,255,255,0.03);
          color: rgba(245,241,234,0.88);
          font-size: 0.92rem;
          cursor: pointer;
        }

        .contact-popover {
          position: absolute;
          top: calc(100% + 12px);
          right: 0;
          width: min(360px, calc(100vw - 36px));
          padding: 16px;
          border-radius: 20px;
          border: 1px solid rgba(255,255,255,0.08);
          background: rgba(14,14,14,0.95);
          box-shadow: 0 28px 60px rgba(0,0,0,0.34);
          backdrop-filter: blur(18px);
          z-index: 60;
        }

        .contact-popover h3 {
          margin: 0;
          font-size: 1rem;
          font-weight: 600;
          color: #fff6ed;
        }

        .contact-popover p {
          margin: 8px 0 0;
          color: rgba(245,241,234,0.62);
          font-size: 0.88rem;
          line-height: 1.55;
        }

        .contact-textarea {
          width: 100%;
          min-height: 110px;
          margin-top: 14px;
          padding: 14px;
          border-radius: 16px;
          border: 1px solid rgba(255,255,255,0.08);
          background: rgba(255,255,255,0.03);
          color: #f5f1ea;
          font: inherit;
          resize: vertical;
        }

        .contact-textarea:focus {
          outline: none;
          border-color: rgba(121, 217, 173, 0.52);
          box-shadow: 0 0 0 3px rgba(31,107,79,0.14);
        }

        .contact-actions {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          margin-top: 14px;
        }

        .contact-actions .request-button,
        .contact-actions .ghost-button {
          flex: 1 1 0;
        }

        .contact-mini {
          margin-top: 12px;
          color: rgba(245,241,234,0.48);
          font-size: 0.82rem;
          line-height: 1.45;
        }

        .hero {
          display: grid;
          grid-template-columns: minmax(260px, 0.82fr) minmax(0, 1.18fr);
          gap: clamp(24px, 3vw, 48px);
          padding: clamp(26px, 3vw, 38px) 28px clamp(18px, 2.5vw, 28px);
          align-items: center;
          justify-items: stretch;
        }

        .hero-copy {
          text-align: left;
          max-width: 440px;
          align-self: start;
          padding-top: clamp(6px, 0.6vw, 12px);
        }

        .eyebrow {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 18px;
          padding: 9px 14px;
          border-radius: 999px;
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.08);
          font-size: 0.78rem;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: rgba(245,241,234,0.72);
        }

        .hero h1 {
          margin: 0;
          max-width: none;
          font-family: 'Fraunces', Georgia, serif;
          font-optical-sizing: auto;
          font-size: clamp(2.4rem, 6vw, 5.4rem);
          line-height: 1.02;
          letter-spacing: -0.01em;
          font-weight: 500;
        }

        .hero p {
          max-width: 36ch;
          margin: 20px 0 0;
          color: rgba(245,241,234,0.65);
          font-size: 1.02rem;
          line-height: 1.9;
        }

        .hero-showcase {
          display: flex;
          flex-direction: column;
          gap: 12px;
          min-width: 0;
        }

        .hero-showcase.is-hidden {
          display: none;
        }

        .hero-visual {
          position: relative;
          width: 100%;
          max-width: none;
          min-height: clamp(380px, 38vw, 660px);
          padding: clamp(12px, 1vw, 18px);
          border-radius: 30px;
          overflow: visible;
          border: 1px solid rgba(255, 255, 255, 0.05);
          background:
            radial-gradient(circle at 50% 12%, rgba(245, 214, 150, 0.1), transparent 36%),
            radial-gradient(circle at 18% 48%, rgba(31, 107, 79, 0.09), transparent 30%),
            radial-gradient(circle at 82% 54%, rgba(18, 35, 58, 0.1), transparent 30%),
            linear-gradient(180deg, rgba(255, 255, 255, 0.015), rgba(255, 255, 255, 0));
          isolation: isolate;
        }

        .hero-visual.has-carousel {
          overflow: visible;
        }

        .hero-visual::before {
          content: '';
          position: absolute;
          inset: clamp(20px, 2vw, 28px) clamp(14px, 1.4vw, 20px) 0;
          border-radius: 42px;
          background:
            radial-gradient(circle at 50% 18%, rgba(240, 212, 155, 0.12), transparent 34%),
            radial-gradient(circle at 18% 52%, rgba(31, 107, 79, 0.12), transparent 28%),
            radial-gradient(circle at 84% 48%, rgba(17, 33, 58, 0.12), transparent 30%),
            linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0));
          filter: blur(22px);
          opacity: 0.75;
          pointer-events: none;
          z-index: 0;
        }

        .hero-carousel-stage {
          position: relative;
          display: grid;
          grid-template-columns: minmax(160px, 0.86fr) minmax(300px, 1.46fr) minmax(160px, 0.86fr);
          gap: clamp(12px, 1.8vw, 26px);
          align-items: end;
          width: min(100%, 1500px);
          height: 100%;
          margin-inline: auto;
          overflow: visible;
          isolation: isolate;
          perspective: 1600px;
          z-index: 1;
        }

        .hero-carousel-slide {
          position: relative;
          display: flex;
          align-items: end;
          justify-content: center;
          min-width: 0;
          min-height: 100%;
          transform-style: preserve-3d;
        }

        .hero-carousel-slide.is-prev {
          grid-column: 1;
          z-index: 1;
          justify-self: end;
        }

        .hero-carousel-slide.is-current {
          grid-column: 2;
          z-index: 3;
          justify-self: center;
        }

        .hero-carousel-slide.is-next {
          grid-column: 3;
          z-index: 2;
          justify-self: start;
        }

        .hero-carousel-card {
          position: relative;
          width: 100%;
          height: clamp(250px, 29vw, 420px);
          border-radius: 30px;
          overflow: hidden;
          border: 1px solid rgba(255,255,255,0.06);
          background:
            linear-gradient(180deg, rgba(0,0,0,0.06), rgba(0,0,0,0.42)),
            radial-gradient(circle at top, rgba(255,220,150,0.12), transparent 45%),
            #121212;
          box-shadow: 0 26px 78px rgba(0,0,0,0.3);
          transform: translateZ(0);
        }

        .hero-carousel-card::after {
          content: '';
          position: absolute;
          inset: 0;
          background: linear-gradient(
            180deg,
            rgba(0,0,0,0.02) 0%,
            rgba(0,0,0,0.08) 26%,
            rgba(0,0,0,0.22) 100%
          );
          pointer-events: none;
        }

        .hero-carousel-card img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          object-position: center center;
          display: block;
        }

        .hero-carousel-slide.is-prev .hero-carousel-card,
        .hero-carousel-slide.is-current .hero-carousel-card,
        .hero-carousel-slide.is-next .hero-carousel-card {
          transition:
            transform 700ms cubic-bezier(0.22, 1, 0.36, 1),
            opacity 700ms cubic-bezier(0.22, 1, 0.36, 1),
            filter 700ms cubic-bezier(0.22, 1, 0.36, 1),
            box-shadow 700ms cubic-bezier(0.22, 1, 0.36, 1);
          will-change: transform, opacity, filter;
          transform-origin: center bottom;
        }

        .hero-carousel-slide.is-prev .hero-carousel-card {
          transform: translateY(28px) scale(0.84) rotateY(11deg);
          opacity: 0.56;
          filter: blur(0.45px) brightness(0.62) saturate(0.78);
          box-shadow: 0 18px 54px rgba(0,0,0,0.2);
        }

        .hero-carousel-slide.is-current .hero-carousel-card {
          transform: translateY(0) scale(1);
          opacity: 1;
          filter: none;
          box-shadow: 0 34px 96px rgba(0,0,0,0.36);
        }

        .hero-carousel-slide.is-next .hero-carousel-card {
          transform: translateY(22px) scale(0.9) rotateY(-10deg);
          opacity: 0.88;
          filter: brightness(0.95) saturate(0.96);
          box-shadow: 0 22px 66px rgba(0,0,0,0.24);
        }

        .hero-visual.is-sliding .hero-carousel-slide.is-prev .hero-carousel-card {
          transform: translateY(30px) scale(0.82) rotateY(11deg);
          opacity: 0.48;
          filter: blur(0.5px) brightness(0.58) saturate(0.76);
        }

        .hero-visual.is-sliding .hero-carousel-slide.is-current .hero-carousel-card {
          transform: translateY(-1px) scale(1);
          opacity: 1;
          filter: none;
          box-shadow: 0 34px 96px rgba(0,0,0,0.36);
        }

        .hero-visual.is-sliding .hero-carousel-slide.is-next .hero-carousel-card {
          transform: translateY(14px) scale(0.94) rotateY(-7deg);
          opacity: 0.97;
          filter: brightness(0.98) saturate(0.98);
          box-shadow: 0 24px 72px rgba(0,0,0,0.28);
        }

        .hero-stage-caption {
          display: flex;
          align-items: end;
          justify-content: space-between;
          gap: 14px;
          padding: 2px 4px 0;
          color: rgba(245,241,234,0.78);
        }

        .hero-category-strip {
          display: flex;
          flex-wrap: wrap;
          gap: 10px;
          align-items: center;
          padding: 0 4px 4px;
        }

        .hero-category-pill {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          border-radius: 999px;
          padding: 10px 14px;
          border: 1px solid rgba(255,255,255,0.08);
          background: rgba(255,255,255,0.03);
          color: rgba(245,241,234,0.74);
          cursor: pointer;
          transition:
            transform 180ms ease,
            background 180ms ease,
            border-color 180ms ease,
            box-shadow 180ms ease,
            color 180ms ease;
        }

        .hero-category-pill span {
          font-size: 0.76rem;
          letter-spacing: 0.18em;
          text-transform: uppercase;
        }

        .hero-category-pill small {
          font-size: 0.72rem;
          letter-spacing: 0.12em;
          color: rgba(245,241,234,0.44);
        }

        .hero-category-pill:hover {
          transform: translateY(-1px);
          border-color: rgba(255,255,255,0.14);
          background: rgba(255,255,255,0.06);
          color: rgba(245,241,234,0.9);
        }

        .hero-category-pill.is-active {
          border-color: rgba(255,220,150,0.28);
          background: linear-gradient(135deg, rgba(255,220,150,0.14), rgba(255,255,255,0.05));
          box-shadow: 0 12px 30px rgba(0,0,0,0.2);
          color: rgba(255,246,232,0.96);
        }

        .hero-stage-caption-copy {
          min-width: 0;
        }

        .hero-stage-kicker {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;
          font-size: 0.7rem;
          letter-spacing: 0.22em;
          text-transform: uppercase;
          color: rgba(245,241,234,0.46);
        }

        .hero-stage-caption strong {
          display: block;
          font-size: 1rem;
          font-weight: 600;
          letter-spacing: 0.02em;
          color: rgba(245,241,234,0.92);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .hero-stage-meta {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
          justify-content: flex-end;
          font-size: 0.76rem;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: rgba(245,241,234,0.44);
        }

        .hero-stage-meta span + span {
          position: relative;
        }

        .hero-stage-meta span + span::before {
          content: '•';
          margin-right: 10px;
          color: rgba(245,241,234,0.28);
        }

        .section { padding: 18px 28px 6px; }

        .compact-header {
          display: flex;
          justify-content: space-between;
          align-items: end;
          gap: 18px;
          flex-wrap: wrap;
          margin-bottom: 18px;
        }

        .compact-copy h2 {
          margin: 0;
          font-family: 'Fraunces', Georgia, serif;
          font-optical-sizing: auto;
          font-size: clamp(1.3rem, 2vw, 1.7rem);
          font-weight: 500;
          letter-spacing: -0.01em;
        }

        .compact-copy p {
          margin: 8px 0 0;
          color: rgba(245,241,234,0.56);
          line-height: 1.6;
        }

        .sales-link {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 999px;
          padding: 10px 14px;
          border: 1px solid rgba(255,255,255,0.08);
          color: rgba(245,241,234,0.82);
          text-decoration: none;
          background: rgba(255,255,255,0.03);
        }

        .category-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(220px, 320px));
          gap: 20px;
          justify-content: center;
        }

        .category-grid.is-expanded {
          grid-template-columns: repeat(auto-fit, minmax(280px, 420px));
          gap: 30px;
        }

        .photo-grid {
          columns: 3 260px;
          column-gap: 18px;
        }

        .category-card,
        .photo-card {
          position: relative;
          break-inside: avoid;
          width: 100%;
          margin: 0 0 18px;
          overflow: hidden;
          border: 1px solid rgba(255,255,255,0.06);
          background: rgba(255,255,255,0.03);
          box-shadow: 0 18px 42px rgba(0,0,0,0.18);
          transition: transform 260ms ease, border-color 260ms ease, box-shadow 260ms ease;
        }

        .category-card {
          border-radius: 28px;
          text-align: left;
          max-width: 320px;
          justify-self: center;
        }

        .category-grid.is-expanded .category-card {
          max-width: 420px;
        }

        .category-card.is-active {
          transform: translateY(-6px) scale(1.04);
          border-color: rgba(240, 212, 155, 0.28);
          box-shadow: 0 34px 64px rgba(0,0,0,0.28);
          z-index: 2;
        }

        .category-card.is-active .card-media img {
          transform: scale(1.08);
        }
        .photo-card { border-radius: 20px; padding: 0; background: transparent; cursor: pointer; }

                .category-card:hover,
        .photo-card:hover {
          transform: translateY(-8px);
          border-color: rgba(240,212,155,0.38);
          box-shadow: 0 34px 64px rgba(0,0,0,0.32), 0 12px 32px rgba(240,212,155,0.14);
        }

        .card-media {
          position: relative;
          overflow: hidden;
          background: #111111;
          aspect-ratio: 16 / 10;
          width: 100%;
        }

        .card-media img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
          transition: transform 260ms ease;
        }

        .category-card:hover .card-media img,
        .photo-card:hover .card-media img {
          transform: scale(1.06);
        }

        .category-label {
          padding: 14px 16px 16px;
          color: #fff6ed;
          font-size: 1rem;
          font-weight: 600;
          text-align: left;
        }

        .back-button {
          border: 1px solid rgba(255,255,255,0.08);
          background: rgba(255,255,255,0.03);
          color: rgba(245,241,234,0.9);
          padding: 10px 14px;
          border-radius: 999px;
          cursor: pointer;
        }

        .floating-counter {
          position: fixed;
          top: 18px;
          right: 18px;
          z-index: 25;
          border-radius: 999px;
          padding: 10px 14px;
          background: rgba(10,10,10,0.64);
          color: rgba(245,241,234,0.84);
          border: 1px solid rgba(255,255,255,0.1);
          backdrop-filter: blur(16px);
          box-shadow: 0 14px 36px rgba(0,0,0,0.25);
          font-size: 0.86rem;
        }

        .info-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 14px;
          padding: 44px 28px 28px;
        }

        .info-panel {
          border-radius: 20px;
          padding: 18px;
          border: 1px solid rgba(255,255,255,0.06);
          background: linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02));
          min-height: 100%;
        }

        .info-panel h3 {
          margin: 0;
          font-size: 1rem;
          font-weight: 600;
        }

        .info-panel p {
          margin: 10px 0 0;
          color: rgba(245,241,234,0.66);
          line-height: 1.65;
          font-size: 0.92rem;
        }

        .contact-list,
        .social-list,
        .plans-grid {
          display: grid;
          gap: 10px;
          margin-top: 14px;
        }

        .contact-item,
        .social-item,
        .plan-card {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 14px;
          border-radius: 16px;
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.06);
        }

        .contact-item span,
        .social-item span {
          font-size: 0.74rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: rgba(245,241,234,0.45);
        }

        .contact-item strong,
        .contact-item a,
        .social-item a {
          color: #fff6ed;
          text-decoration: none;
          font-size: 0.94rem;
          word-break: break-word;
        }

        .social-item small,
        .info-note {
          color: rgba(245,241,234,0.52);
          font-size: 0.84rem;
          line-height: 1.5;
        }

        .plan-top {
          display: flex;
          justify-content: space-between;
          align-items: start;
          gap: 12px;
          flex-wrap: wrap;
        }

        .plan-name {
          margin: 0;
          color: #fff6ed;
          font-size: 0.96rem;
          font-weight: 600;
        }

        .plan-price {
          color: #f6d36a;
          font-size: 0.96rem;
          font-weight: 700;
        }

        .plan-description {
          margin: 8px 0 0;
          color: rgba(245,241,234,0.62);
          line-height: 1.6;
          font-size: 0.88rem;
        }

        .modal-overlay {
          position: fixed;
          inset: 0;
          z-index: 60;
          display: flex;
          align-items: flex-start;
          justify-content: center;
          padding: 22px;
          background: rgba(0,0,0,0.82);
          backdrop-filter: blur(16px) saturate(1.2);
          overflow-y: auto;
          overscroll-behavior: contain;
        }

        .modal-content {
          width: min(1260px, 96vw);
          animation: modalSpring 380ms cubic-bezier(0.16, 1, 0.3, 1);
          margin: auto 0;
        }

        .modal-content.is-overview {
          width: min(1120px, 96vw);
        }

        .modal-image-wrap {
          position: relative;
          border-radius: 28px;
          overflow: hidden;
          border: 1px solid rgba(255,255,255,0.08);
          background: rgba(255,255,255,0.03);
        }

        .modal-image {
          width: 100%;
          max-height: 78vh;
          object-fit: contain;
          display: block;
        }

        .modal-nav,
        .modal-close,
        .modal-select {
          position: absolute;
          z-index: 3;
          color: #fff;
          cursor: pointer;
          backdrop-filter: blur(12px);
        }

        .modal-nav,
        .modal-close {
          border: none;
          background: rgba(10,10,10,0.48);
        }

        .modal-nav {
          top: 50%;
          transform: translateY(-50%);
          width: 52px;
          height: 52px;
          border-radius: 999px;
          font-size: 1.5rem;
        }

        .modal-close {
          top: 18px;
          right: 18px;
          width: 46px;
          height: 46px;
          border-radius: 999px;
          font-size: 1.2rem;
          line-height: 1;
        }

        .modal-select {
          top: 18px;
          left: 18px;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          border: 1px solid rgba(255,255,255,0.2);
          background: rgba(10,10,10,0.52);
          border-radius: 999px;
          padding: 10px 14px;
          font-size: 0.88rem;
          font-weight: 600;
        }

        .modal-select.active {
          background: rgba(31,107,79,0.86);
          border-color: rgba(121, 217, 173, 0.66);
        }

        .modal-select-mark {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 18px;
          height: 18px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.42);
          font-size: 0.72rem;
          line-height: 1;
          flex: 0 0 auto;
        }

        .modal-info {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 14px;
          padding: 18px 12px 0;
          text-align: center;
        }

        .modal-overview {
          padding: 18px;
        }

        .modal-overview-top {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          margin-bottom: 16px;
          flex-wrap: wrap;
        }

        .modal-overview-copy {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .modal-overview-kicker {
          color: rgba(245,241,234,0.54);
          font-size: 0.86rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }

        .modal-overview-title {
          margin: 0;
          font-family: 'Fraunces', Georgia, serif;
          font-optical-sizing: auto;
          font-size: clamp(1.25rem, 2vw, 1.7rem);
          font-weight: 600;
          color: #fff6ed;
        }

        .modal-overview-meta {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
          color: rgba(245,241,234,0.62);
          font-size: 0.92rem;
        }

        .modal-overview-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
          gap: 14px;
          margin-top: 18px;
        }

        .modal-overview-card {
          position: relative;
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 18px;
          overflow: hidden;
          padding: 0;
          background: rgba(255,255,255,0.04);
          cursor: pointer;
          box-shadow: 0 16px 30px rgba(0,0,0,0.2);
          transform: translateY(0);
          transition: transform 220ms ease, box-shadow 220ms ease, border-color 220ms ease;
        }

                .modal-overview-card:hover {
          transform: translateY(-6px);
          box-shadow: 0 24px 48px rgba(0,0,0,0.3), 0 10px 28px rgba(246,211,106,0.16);
          border-color: rgba(246,211,106,0.55);
        }

        .modal-overview-card.active {
          border-color: rgba(246,211,106,0.82);
          box-shadow: 0 0 0 2px rgba(246,211,106,0.2), 0 20px 40px rgba(0,0,0,0.26);
        }

        .modal-overview-card img {
          width: 100%;
          height: 180px;
          object-fit: cover;
          display: block;
          background: rgba(255,255,255,0.05);
          filter: blur(1.2px);
        }

        .modal-overview-card-index {
          position: absolute;
          top: 10px;
          left: 10px;
          min-width: 28px;
          height: 28px;
          padding: 0 8px;
          border-radius: 999px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: rgba(10,10,10,0.6);
          color: #fff6ed;
          font-size: 0.78rem;
          font-weight: 700;
          backdrop-filter: blur(10px);
        }

        .modal-overview-card.active .modal-overview-card-index {
          background: rgba(246,211,106,0.94);
          color: #1c1306;
        }

        .modal-overview-card-label {
          padding: 10px 12px 12px;
          color: rgba(245,241,234,0.86);
          font-size: 0.85rem;
          font-weight: 600;
          text-align: left;
        }

        .modal-title {
          margin: 0;
          font-size: 1.08rem;
          font-weight: 600;
        }

        .modal-sub {
          color: rgba(245,241,234,0.54);
          font-size: 0.92rem;
        }

        .modal-actions,
        .modal-thumb-row {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
          flex-wrap: wrap;
        }

        .modal-thumb-row {
          margin-top: 4px;
          overflow-x: auto;
          padding: 6px 2px 2px;
        }

        .thumb-button {
          width: 72px;
          height: 72px;
          border-radius: 18px;
          overflow: hidden;
          border: 1px solid rgba(255,255,255,0.1);
          padding: 0;
          background: rgba(255,255,255,0.05);
          cursor: pointer;
          flex: 0 0 auto;
          position: relative;
          box-shadow: 0 14px 28px rgba(0,0,0,0.18);
        }

        .thumb-button.active {
          border-color: rgba(246,211,106,0.8);
          box-shadow: 0 0 0 2px rgba(246,211,106,0.18);
        }

        .thumb-button:not(.active):hover {
          transform: translateY(-1px);
          border-color: rgba(255,255,255,0.2);
        }

        .thumb-button img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
          filter: blur(1.2px);
        }

        .badge {
          padding: 9px 14px;
          border-radius: 999px;
          background: rgba(255,255,255,0.07);
          border: 1px solid rgba(255,255,255,0.1);
          color: white;
          font-size: 0.86rem;
          font-weight: 600;
        }

        .badge-gold {
          background: linear-gradient(135deg, #f6d36a, #d59f1f);
          color: #1c1306;
          border: none;
        }

        .selection-summary {
          margin-top: 4px;
          color: rgba(245,241,234,0.68);
          font-size: 0.88rem;
        }

        .footer {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 18px;
          flex-wrap: wrap;
          padding: 24px 28px 30px;
          color: rgba(245,241,234,0.48);
          border-top: 1px solid transparent;
          border-image: linear-gradient(90deg, transparent, rgba(240,212,155,0.45), transparent) 1;
        }

        .footer-socials {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          margin-top: 10px;
        }

        .footer-socials a {
          display: inline-flex;
          align-items: center;
          padding: 8px 12px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.08);
          background: rgba(255,255,255,0.03);
          color: rgba(245,241,234,0.82);
          text-decoration: none;
          font-size: 0.86rem;
        }

        @media (max-width: 1120px) {
          .hero {
            grid-template-columns: 1fr;
            justify-items: center;
          }
          .info-grid { grid-template-columns: 1fr 1fr; }
          .hero h1 { max-width: none; }
          .hero-copy {
            text-align: center;
            max-width: 760px;
            padding-top: 0;
          }
          .hero p {
            margin-left: auto;
            margin-right: auto;
            max-width: 660px;
          }
          .hero-showcase {
            width: 100%;
            max-width: none;
          }
          .hero-visual {
            min-height: clamp(320px, 42vw, 580px);
            padding: clamp(10px, 0.9vw, 14px);
          }
          .hero-carousel-stage {
            grid-template-columns: minmax(120px, 0.8fr) minmax(0, 1.36fr) minmax(120px, 0.8fr);
            gap: clamp(10px, 1.6vw, 20px);
            width: min(100%, 1360px);
          }
          .hero-carousel-card {
            height: clamp(220px, 28vw, 360px);
          }
          .hero-carousel-slide.is-prev .hero-carousel-card {
            transform: translateY(24px) scale(0.84) rotateY(10deg);
          }
          .hero-carousel-slide.is-next .hero-carousel-card {
            transform: translateY(18px) scale(0.9) rotateY(-9deg);
          }
          .hero-visual.is-sliding .hero-carousel-slide.is-prev .hero-carousel-card {
            transform: translateY(28px) scale(0.8) rotateY(10deg);
          }
          .hero-visual.is-sliding .hero-carousel-slide.is-current .hero-carousel-card {
            transform: translateY(-1px) scale(1);
          }
          .hero-visual.is-sliding .hero-carousel-slide.is-next .hero-carousel-card {
            transform: translateY(10px) scale(0.94) rotateY(-8deg);
          }
          .hero-stage-caption {
            padding: 2px 6px 0;
          }
          .hero-category-strip {
            padding: 0 6px 4px;
          }
        }

        @media (max-width: 780px) {
          .portfolio-shell { width: 100%; padding-top: 10px; }
          .top-nav, .hero, .section, .info-grid, .footer { padding-left: 18px; padding-right: 18px; }
          .top-nav { flex-direction: column; align-items: flex-start; }
          .nav-links { width: 100%; justify-content: space-between; }
          .nav-contact { width: 100%; }
          .contact-toggle { width: 100%; }
          .contact-popover { left: 0; right: auto; width: 100%; }
          .request-button { width: 100%; }
          .category-grid,
          .info-grid { grid-template-columns: 1fr; }
          .photo-grid { columns: 1; }
          .modal-overview { padding: 14px; }
          .modal-overview-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 10px;
          }
          .modal-overview-card img {
            height: 140px;
          }
          .thumb-button {
            width: 62px;
            height: 62px;
            border-radius: 16px;
          }
          .modal-nav { width: 42px; height: 42px; }
          .modal-select { top: 12px; left: 12px; }
          .modal-close { top: 12px; right: 12px; }
          .floating-counter { top: auto; bottom: 14px; right: 14px; }
          .compact-header { align-items: flex-start; }
          .hero {
            gap: 16px;
            padding-top: 20px;
            padding-bottom: 16px;
            justify-items: stretch;
          }
          .hero h1 { font-size: clamp(2.2rem, 11vw, 3.4rem); }
          .hero-copy {
            text-align: center;
            max-width: 760px;
          }
          .hero-visual {
            min-height: clamp(300px, 72vw, 500px);
            padding: 10px;
          }
          .hero-carousel-stage {
            grid-template-columns: minmax(84px, 0.66fr) minmax(0, 1.18fr) minmax(84px, 0.66fr);
            gap: 10px;
            width: min(100%, 980px);
          }
          .hero-carousel-card {
            height: clamp(180px, 34vw, 260px);
            border-radius: 24px;
          }
          .hero-carousel-slide.is-prev .hero-carousel-card {
            transform: translateY(18px) scale(0.82) rotateY(9deg);
            opacity: 0.52;
            filter: blur(0.35px) brightness(0.58) saturate(0.76);
          }
          .hero-carousel-slide.is-next .hero-carousel-card {
            transform: translateY(14px) scale(0.88) rotateY(-8deg);
            opacity: 0.9;
          }
          .hero-visual.is-sliding .hero-carousel-slide.is-prev .hero-carousel-card {
            transform: translateY(20px) scale(0.8) rotateY(9deg);
          }
          .hero-visual.is-sliding .hero-carousel-slide.is-current .hero-carousel-card {
            transform: translateY(0) scale(1);
          }
          .hero-visual.is-sliding .hero-carousel-slide.is-next .hero-carousel-card {
            transform: translateY(8px) scale(0.92) rotateY(-7deg);
          }
          .hero-stage-caption {
            flex-direction: column;
            align-items: flex-start;
          }
          .hero-category-strip {
            justify-content: center;
            padding: 0 0 2px;
          }
          .hero-stage-meta {
            justify-content: flex-start;
          }
        }
      
        /* ---- Rediseno visual 2026 ---- */
        @keyframes heroRise {
          from { opacity: 0; transform: translateY(22px); }
          to { opacity: 1; transform: none; }
        }

        .hero-copy > * {
          animation: heroRise 700ms cubic-bezier(0.16, 1, 0.3, 1) both;
        }

        .hero-copy > :nth-child(2) { animation-delay: 90ms; }
        .hero-copy > :nth-child(3) { animation-delay: 180ms; }

        /* Grano de pelicula sutil */
        body::after {
          content: "";
          position: fixed;
          inset: 0;
          z-index: 40;
          pointer-events: none;
          opacity: 0.05;
          background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
          background-size: 160px 160px;
        }

        /* Puntos del carrusel del hero */
        .hero-dots {
          display: flex;
          align-items: center;
          gap: 8px;
          padding-bottom: 4px;
        }

        .hero-dot {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          border: none;
          padding: 0;
          cursor: pointer;
          background: rgba(245,241,234,0.25);
          transition: width 300ms ease, background 300ms ease;
        }

        .hero-dot:hover { background: rgba(245,241,234,0.5); }

        .hero-dot.is-active {
          width: 28px;
          background: linear-gradient(90deg, #f0d49b, #d59f1f);
        }

        /* Entrada del modal con spring */
        @keyframes modalSpring {
          from { opacity: 0; transform: translateY(16px) scale(0.98); }
          to { opacity: 1; transform: none; }
        }

        .modal-close {
          transition: transform 300ms ease, background 300ms ease;
        }

        .modal-close:hover { transform: rotate(90deg); }

        /* Pop al marcar foto */
        @keyframes selectPop {
          0% { transform: scale(0.6); }
          60% { transform: scale(1.25); }
          100% { transform: scale(1); }
        }

        .modal-select.active .modal-select-mark {
          animation: selectPop 320ms cubic-bezier(0.16, 1, 0.3, 1);
        }

        /* Boton principal con glow */
        .request-button {
          box-shadow: 0 18px 40px rgba(0, 0, 0, 0.24), 0 6px 22px rgba(31, 107, 79, 0.32);
        }

        .request-button:hover:not(:disabled) {
          transform: translateY(-3px);
          box-shadow:
            0 22px 46px rgba(0, 0, 0, 0.3),
            0 10px 30px rgba(31, 107, 79, 0.48),
            0 0 0 1px rgba(121, 217, 173, 0.32);
        }

        /* Scrollbar acorde al tema */
        ::-webkit-scrollbar { width: 10px; height: 10px; }
        ::-webkit-scrollbar-track { background: #0a0a0a; }
        ::-webkit-scrollbar-thumb {
          background: linear-gradient(180deg, #8d672d, #4a3a1c);
          border-radius: 999px;
        }

        /* Reveal al hacer scroll (solo si el browser lo soporta) */
        @supports (animation-timeline: view()) {
          @keyframes cardReveal {
            from { opacity: 0; translate: 0 28px; }
            to { opacity: 1; translate: 0 0; }
          }

          .category-card,
          .photo-card {
            animation: cardReveal 600ms cubic-bezier(0.16, 1, 0.3, 1);
            animation-timeline: view();
            animation-range: entry 0% cover 20%;
          }
        }

        /* Respetar prefers-reduced-motion */
        @media (prefers-reduced-motion: reduce) {
          html { scroll-behavior: auto; }
          *,
          *::before,
          *::after {
            animation-duration: 0.01ms !important;
            animation-iteration-count: 1 !important;
            transition-duration: 0.01ms !important;
          }
        }
      `}</style>

      <div className="portfolio-shell">
        <div className="glass-frame">
          <div className="top-nav">
            <div className="brand">
              <div className="brand-mark">CP</div>
            <div className="brand-copy">
                <span>Eventos, retratos, paisajes y escena en vivo</span>
              </div>
            </div>

            <div className="nav-links">
                            <Link
                to="/"
                className="contact-toggle"
                onClick={returnToPortfolio}
              >
                Portfolio
              </Link>
              <div className="nav-contact">
                <button
                  type="button"
                  className="contact-toggle"
                  ref={contactToggleRef}
                  onClick={() => setIsContactOpen((current) => !current)}
                >
                  Contacto
                </button>

                {isContactOpen && (
                  <div className="contact-popover" ref={contactPopoverRef}>
                    <h3>Contacto</h3>
                    <p>Escribime desde aca y seguimos por WhatsApp o correo, sin salir del portfolio.</p>

                    <textarea
                      className="contact-textarea"
                      placeholder="Hola, queria consultarte por..."
                      value={contactDraft}
                      onChange={(event) => setContactDraft(event.target.value)}
                    />

                    <div className="contact-actions">
                      <button
                        type="button"
                        className="request-button"
                        onClick={handleContactWhatsApp}
                        disabled={!whatsAppNumber}
                      >
                        WhatsApp
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        onClick={handleContactEmail}
                        disabled={!contactEmail}
                      >
                        Email
                      </button>
                    </div>

                    <div className="contact-mini">
                      {whatsAppNumber || 'WhatsApp no configurado'}
                      <br />
                      {contactEmail}
                      <br />
                      {location}
                    </div>
                  </div>
                )}
              </div>
              {selectedCategory && !modalImage && (
                <button
                  type="button"
                  className="request-button"
                  onClick={() =>
                    handleWhatsAppRequest(
                      selectedPhotos.length > 0 ? selectedPhotos : primaryWhatsAppImage
                    )
                  }
                  disabled={!whatsAppNumber || (!primaryWhatsAppImage && selectedPhotos.length === 0)}
                >
                  {selectedPhotos.length > 0
                    ? `Solicitar seleccionadas (${selectedPhotos.length})`
                    : 'Solicitar fotos'}
                </button>
              )}
            </div>
          </div>

          <header className="hero" id="portfolio">
            <div className="hero-copy">
              <div className="eyebrow">Portfolio</div>
              <h1>{adminName || 'César Dario'}</h1>
              <p>
                Fotografia de eventos, retratos y escenas en vivo. Trabajo en bodas, 15 años,
                books, paisajes, playa, recitales, cuarteto, boliches y proyectos visuales de
                todo tipo.
              </p>
            </div>

            <div className={`hero-showcase ${selectedCategory ? 'is-hidden' : ''}`}>
              <div className={`hero-visual ${heroCarouselImages.length > 1 ? 'has-carousel' : ''} ${heroSlideState.animating ? 'is-sliding' : ''}`}>
                {heroCurrentImage?.url ? (
                  <div className="hero-carousel-stage">
                    {heroCarouselImages.length > 1 && heroPrevImage?.url ? (
                      <div className="hero-carousel-slide is-prev">
                        <div className="hero-carousel-card">
                          <img
                            key={heroPrevImage.id}
                            src={heroPrevImage.url}
                            alt={heroPrevImage.label || heroPrevImage.category || 'Portada'}
                            loading="eager"
                            onContextMenu={blockImageInteraction}
                            onDragStart={blockImageInteraction}
                            onError={() => handleImageError(heroPrevImage.url)}
                          />
                        </div>
                      </div>
                    ) : null}
                    <div className="hero-carousel-slide is-current">
                      <div className="hero-carousel-card">
                        <img
                          key={heroCurrentImage.id}
                          src={heroCurrentImage.url}
                          alt={heroCurrentImage.label || heroCurrentImage.category || 'Portada'}
                          loading="eager"
                          onContextMenu={blockImageInteraction}
                          onDragStart={blockImageInteraction}
                          onError={() => handleImageError(heroCurrentImage.url)}
                        />
                      </div>
                    </div>
                    {heroCarouselImages.length > 1 && heroNextImage?.url ? (
                      <div className="hero-carousel-slide is-next">
                        <div className="hero-carousel-card">
                          <img
                            key={heroNextImage.id}
                            src={heroNextImage.url}
                            alt={heroNextImage.label || heroNextImage.category || 'Portada'}
                            loading="eager"
                            onContextMenu={blockImageInteraction}
                            onDragStart={blockImageInteraction}
                            onError={() => handleImageError(heroNextImage.url)}
                          />
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <ImageSkeleton height={420} />
                )}
              </div>

              {heroCategoryOptions.length > 1 ? (
                <div className="hero-category-strip" aria-label="Filtrar carrusel por categoria">
                  {heroCategoryOptions.map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      className={`hero-category-pill ${heroCategoryKey === option.key ? 'is-active' : ''}`}
                      onClick={() => {
                        setHeroCategoryKey(option.key);
                        setHeroCoverIndex(0);
                        heroCoverIndexRef.current = 0;
                        setHeroSlideState({ animating: false, from: 0, to: 0 });
                      }}
                      aria-pressed={heroCategoryKey === option.key}
                    >
                      <span>{option.label}</span>
                      <small>{option.count}</small>
                    </button>
                  ))}
                </div>
              ) : null}

                {heroCurrentImage?.url ? (
                <div className="hero-stage-caption" aria-label="Hero cover details">
                  <div className="hero-stage-caption-copy">
                  <div className="hero-stage-kicker">Portada seleccionada</div>
                    <strong>{heroCurrentImage.label || heroCurrentImage.category || 'Portada'}</strong>
                  </div>
                  {heroCarouselImages.length > 1 ? (
                    <div className="hero-dots" role="tablist" aria-label="Portadas">
                      {heroCarouselImages.map((image, dotIndex) => (
                        <button
                          key={image.id}
                          type="button"
                          role="tab"
                          aria-selected={dotIndex === heroCarouselCurrentIndex}
                          aria-label={'Portada ' + (dotIndex + 1)}
                          className={'hero-dot' + (dotIndex === heroCarouselCurrentIndex ? ' is-active' : '')}
                          onClick={() => goToHeroSlide(dotIndex)}
                        />
                      ))}
                    </div>
                  ) : null}
                  <div className="hero-stage-meta">
                    <span>{heroCategoryOptions.find((option) => option.key === heroCategoryKey)?.label || heroCurrentImage.category || 'General'}</span>
                    <span>
                      {heroCarouselImages.length > 0 ? `${heroCarouselCurrentIndex + 1}/${heroCarouselImages.length}` : '1/1'}
                    </span>
                  </div>
                </div>
              ) : null}
            </div>
          </header>

          {selectedCategory && activeCategory && (
            <section className="section">
              <div className="compact-header">
                <div className="compact-copy">
                  <button
                    type="button"
                    className="back-button"
                    onClick={() => {
                      if (selectedParentGroup) {
                        setSelectedParentGroup(null);
                        setSelectedAlbumKey(null);
                        setModalIndex(null);
                        return;
                      }

                      returnToPortfolio();
                    }}
                  >
                    {selectedParentGroup ? 'Volver a la categoria' : 'Volver al portfolio'}
                  </button>
                  <h2 style={{ marginTop: '14px' }}>
                    {selectedParentGroup || activeCategory.name}
                  </h2>
                <p>
                  {selectedParentGroup
                      ? `${activeParentGroup?.albums.length || 0} evento(s) dentro de este grupo.`
                      : `${activeCategory.albums.length} evento(s) dentro de esta categoria. Abri un evento para ver su galeria completa y marcar las fotos que quieras pedir.`}
                  </p>
                </div>
              </div>

              {selectedPhotoIds.length > 0 && (
                <button
                  type="button"
                  className="request-button"
                  onClick={() => handleWhatsAppRequest(selectedPhotos)}
                  disabled={!whatsAppNumber}
                  style={{ marginTop: '16px' }}
                >
                  Pedir {selectedPhotoIds.length} seleccionada(s)
                </button>
              )}
            </section>
          )}

          <section className="section">
            {!selectedCategory && serviceShowcaseText ? (
              <div
                className="selection-summary"
                style={{
                  marginBottom: '18px',
                  padding: '16px 18px',
                  border: '1px solid rgba(232, 219, 199, 0.12)',
                  borderRadius: '18px',
                  background: 'rgba(255,255,255,0.04)',
                  backdropFilter: 'blur(14px)',
                }}
              >
                <div style={{ fontSize: '0.76rem', letterSpacing: '0.18em', textTransform: 'uppercase', opacity: 0.68 }}>
                  Services
                </div>
                <div style={{ marginTop: '8px', opacity: 0.84, lineHeight: 1.5 }}>
                  Coberturas, books y trabajos editoriales disponibles: {serviceShowcaseText}.
                </div>
              </div>
            ) : null}
            {loading ? (
              <div className="category-grid">
                {[...Array(6)].map((_, index) => (
                  <ImageSkeleton key={index} />
                ))}
              </div>
              ) : selectedCategory ? (
                selectedParentGroup && activeParentGroup ? (
                  activeParentGroup.albums.length === 0 ? (
                  <div
                    style={{
                      textAlign: 'center',
                      padding: '72px 20px',
                      color: 'rgba(245,241,234,0.56)',
                    }}
                  >
                    No hay eventos en este grupo.
                  </div>
                ) : (
                  <div className="category-grid is-expanded">
                    {activeParentGroup.albums.map((album) => (
                      <button
                        key={album.key}
                        type="button"
                        className={`category-card ${selectedAlbumKey === album.key ? 'is-active' : ''}`}
                        onClick={() => openAlbum(activeCategory.name, album.key, activeParentGroup.title)}
                      >
                        <div className="card-media">
                          <img
                            src={thumbSrc(album.cover) || thumbSrc(album.images[0])}
                            alt={album.title}
                            loading="lazy"
                            onContextMenu={blockImageInteraction}
                            onDragStart={blockImageInteraction}
                            onError={() => handleImageError(album.cover?.url || album.images[0]?.url)}
                          />
                        </div>
                        <div className="category-label">{album.title}</div>
                      </button>
                    ))}
                  </div>
                )
              ) : activeCategory.parentGroups.length > 0 ? (
                <>
                  <div className="category-grid is-expanded">
                    {activeCategory.parentGroups.map((group) => (
                      <button
                        key={group.key}
                        type="button"
                        className="category-card"
                        onClick={() => openParentGroup(group.title)}
                      >
                        <div className="card-media">
                          <img
                            src={thumbSrc(group.cover) || thumbSrc(group.images[0])}
                            alt={group.title}
                            loading="lazy"
                            onContextMenu={blockImageInteraction}
                            onDragStart={blockImageInteraction}
                            onError={() => handleImageError(group.cover?.url || group.images[0]?.url)}
                          />
                        </div>
                        <div className="category-label">{group.title}</div>
                      </button>
                    ))}
                  </div>

                  {activeCategory.directAlbums.length > 0 && (
                    <div className="category-grid is-expanded" style={{ marginTop: '18px' }}>
                      {activeCategory.directAlbums.map((album) => (
                      <button
                        key={album.key}
                        type="button"
                        className={`category-card ${selectedAlbumKey === album.key ? 'is-active' : ''}`}
                        onClick={() => openAlbum(activeCategory.name, album.key)}
                      >
                          <div className="card-media">
                            <img
                              src={thumbSrc(album.cover) || thumbSrc(album.images[0])}
                              alt={album.title}
                              loading="lazy"
                              onContextMenu={blockImageInteraction}
                              onDragStart={blockImageInteraction}
                              onError={() => handleImageError(album.cover?.url || album.images[0]?.url)}
                            />
                          </div>
                          <div className="category-label">{album.title}</div>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : activeCategory.albums.length === 0 ? (
                <div
                  style={{
                    textAlign: 'center',
                    padding: '72px 20px',
                    color: 'rgba(245,241,234,0.56)',
                  }}
                >
                  No hay eventos en esta categoria.
                </div>
              ) : (
                <div className="category-grid is-expanded">
                  {activeCategory.albums.map((album) => (
                    <button
                      key={album.key}
                      type="button"
                      className={`category-card ${selectedAlbumKey === album.key ? 'is-active' : ''}`}
                      onClick={() => openAlbum(activeCategory.name, album.key)}
                    >
                      <div className="card-media">
                        <img
                          src={thumbSrc(album.cover) || thumbSrc(album.images[0])}
                          alt={album.title}
                          loading="lazy"
                          onContextMenu={blockImageInteraction}
                          onDragStart={blockImageInteraction}
                          onError={() => handleImageError(album.cover?.url || album.images[0]?.url)}
                        />
                      </div>
                      <div className="category-label">{album.title}</div>
                    </button>
                  ))}
                </div>
              )
            ) : categories.length === 0 ? (
              <div
                style={{
                  textAlign: 'center',
                  padding: '72px 20px',
                  color: 'rgba(245,241,234,0.56)',
                }}
              >
                No hay imagenes disponibles todavia.
              </div>
            ) : (
              <div className="category-grid">
                {categories.map((category) => (
                  <button
                    key={category.name}
                    type="button"
                    className="category-card"
                    onClick={() => openCategory(category.name)}
                  >
                    <div className="card-media">
                      <img
                        src={thumbSrc(category.cover) || thumbSrc(category.images[0])}
                        alt={category.name}
                        loading="lazy"
                        onContextMenu={blockImageInteraction}
                        onDragStart={blockImageInteraction}
                        onError={() => handleImageError(category.cover?.url || category.images[0]?.url)}
                      />
                    </div>
                    <div className="category-label">{category.name}</div>
                  </button>
                ))}
              </div>
            )}
          </section>

          <footer className="footer">
            <div>
              {<div style={{ fontWeight: 600, color: '#fff6ed' }}>{adminName || 'César Dario'}</div>}
              <div style={{ marginTop: '6px' }}>
                Fotografia para eventos, retratos y proyectos visuales.
              </div>
              <div className="footer-socials">
                {INSTAGRAM_LINKS.map((account) => (
                  <a key={account.href} href={account.href} target="_blank" rel="noreferrer">
                    {account.label}
                  </a>
                ))}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div>{contactEmail}</div>
              <div style={{ marginTop: '6px' }}>{location}</div>
            </div>
          </footer>
        </div>

        {isGalleryModalOpen && activeAlbum && (
          <div className="modal-overlay" onClick={closeModal}>
            <div className="modal-content" onClick={(event) => event.stopPropagation()}>
              {!modalImage ? (
                <div className="modal-overview">
                  <div className="modal-overview-top">
                    <div className="modal-overview-copy">
                      <div className="modal-overview-kicker">Vista previa del album</div>
                      <h3 className="modal-overview-title">{activeAlbum.title}</h3>
                      <div className="modal-overview-meta">
                        {selectedCategory && <span className="badge">{selectedCategory}</span>}
                        <span className="badge">{activeAlbumImages.length} foto(s)</span>
                        <span className="badge">Toca una miniatura para abrirla</span>
                      </div>
                    </div>
                    <button type="button" className="modal-close" onClick={closeModal}>
                      X
                    </button>
                  </div>

                  <div className="modal-overview-grid">
                    {activeAlbumImages.map((image, index) => {
                      const isActive = isPhotoSelected(image.id);

                      return (
                        <button
                          key={image.id}
                          type="button"
                          className={`modal-overview-card ${isActive ? 'active' : ''}`}
                          onClick={() => setModalIndex(index)}
                        >
                          <img
                            src={thumbSrc(image)}
                            alt={image.label || `Foto ${index + 1}`}
                            onContextMenu={blockImageInteraction}
                            onDragStart={blockImageInteraction}
                            onError={() => handleImageError(image.url)}
                          />
                          <span className="modal-overview-card-index">{index + 1}</span>
                          <div className="modal-overview-card-label">
                            {image.label || `Foto ${index + 1}`}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <>
              <div className="modal-image-wrap">
                <img
                  className="modal-image"
                  src={modalImage.url}
                  alt={modalImage.label || 'Imagen del portfolio'}
                  onContextMenu={blockImageInteraction}
                  onDragStart={blockImageInteraction}
                  style={{ filter: MODAL_BLUR }}
                />

                <button
                  type="button"
                  className={`modal-select ${isPhotoSelected(modalImage.id) ? 'active' : ''}`}
                  onClick={() => toggleSelectedPhoto(modalImage)}
                >
                  <span className="modal-select-mark">
                    {isPhotoSelected(modalImage.id) ? '✓' : ''}
                  </span>
                  {isPhotoSelected(modalImage.id) ? 'Seleccionada' : 'Seleccionar'}
                </button>

                <button
                  type="button"
                  className="modal-nav"
                  style={{ left: '18px' }}
                  onClick={() =>
                    setModalIndex((current) =>
                      (current - 1 + activeAlbumImages.length) % activeAlbumImages.length
                    )
                  }
                >
                  {'<'}
                </button>

                <button
                  type="button"
                  className="modal-nav"
                  style={{ right: '18px' }}
                  onClick={() => setModalIndex((current) => (current + 1) % activeAlbumImages.length)}
                >
                  {'>'}
                </button>

                <button type="button" className="modal-close" onClick={closeModal}>
                  X
                </button>
              </div>

              <div className="modal-info">
                {modalImage.label && <p className="modal-title">{modalImage.label}</p>}
                <div className="modal-sub">
                  {modalIndex + 1} / {activeAlbumImages.length}
                </div>
                <div className="modal-actions">
                  {modalImage.isFeatured && <span className="badge badge-gold">Destacado</span>}
                  {selectedCategory && <span className="badge">{selectedCategory}</span>}
                  {activeAlbum?.title && <span className="badge">{activeAlbum.title}</span>}
                  {selectedPhotoIds.length > 0 && (
                    <span className="badge">{selectedPhotoIds.length} seleccionada(s)</span>
                  )}
                </div>

                <div className="modal-actions">
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => toggleSelectedPhoto(modalImage)}
                  >
                    {isPhotoSelected(modalImage.id) ? 'Quitar marca' : 'Marcar para compra'}
                  </button>
                  <button
                    type="button"
                    className="request-button"
                    onClick={() =>
                      handleWhatsAppRequest(
                        selectedPhotos.length > 0 ? selectedPhotos : [modalImage]
                      )
                    }
                    disabled={!whatsAppNumber}
                  >
                    {selectedPhotoIds.length > 0
                      ? `Solicitar ${selectedPhotoIds.length} foto(s)`
                      : 'Solicitar esta foto'}
                  </button>
                </div>

                {selectedPhotoIds.length > 0 && pricingRecommendation && (
                  <div
                    className="selection-summary"
                    style={{
                      marginTop: '16px',
                      padding: '16px',
                      border: '1px solid rgba(232, 219, 199, 0.16)',
                      borderRadius: '18px',
                      background:
                        'linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.04))',
                      backdropFilter: 'blur(18px)',
                      boxShadow: '0 18px 60px rgba(0, 0, 0, 0.18)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
                      <div>
                        <div style={{ fontSize: '0.74rem', letterSpacing: '0.18em', textTransform: 'uppercase', opacity: 0.68 }}>
                          Resumen premium de selección
                        </div>
                        <div style={{ marginTop: '10px', fontSize: '1.1rem', fontWeight: 600 }}>
                          {selectedPhotoIds.length} foto{selectedPhotoIds.length === 1 ? '' : 's'} seleccionada{selectedPhotoIds.length === 1 ? '' : 's'}
                        </div>
                        <div style={{ marginTop: '8px', opacity: 0.82 }}>
                          Sugerencia editorial: {pricingSummaryText}
                        </div>
                      </div>

                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '0.74rem', letterSpacing: '0.18em', textTransform: 'uppercase', opacity: 0.68 }}>
                          Total estimado
                        </div>
                        <div style={{ marginTop: '10px', fontSize: '1.22rem', fontWeight: 700 }}>
                          {formatMoney(pricingRecommendation.estimatedTotal)}
                        </div>
                        {pricingRecommendation.savings !== null && pricingRecommendation.savings > 0 && (
                          <div style={{ marginTop: '8px', opacity: 0.82 }}>
                            Est. savings {formatMoney(pricingRecommendation.savings)}
                          </div>
                        )}
                      </div>
                    </div>

                    <div style={{ marginTop: '14px', display: 'grid', gap: '10px' }}>
                      {pricingRecommendation.selectedPlans.map((plan) => (
                        <div
                          key={plan.key}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            gap: '12px',
                            padding: '12px 14px',
                            borderRadius: '14px',
                            background: 'rgba(255,255,255,0.04)',
                          }}
                        >
                          <div>
                            <div style={{ fontWeight: 600 }}>
                              {plan.count} x {formatPricingPlanName(plan)}
                            </div>
                            <div style={{ marginTop: '4px', fontSize: '0.92rem', opacity: 0.72 }}>
                              {plan.size === 1 ? 'Selección individual' : `Pack editorial de ${plan.size} fotos`}
                            </div>
                          </div>
                          <div style={{ fontWeight: 600 }}>{formatMoney(plan.amount * plan.count)}</div>
                        </div>
                      ))}
                    </div>

                    <div style={{ marginTop: '14px', fontSize: '0.92rem', lineHeight: 1.55, opacity: 0.8 }}>
                      Ajustado para selecciones editoriales. Esto es solo una estimación visual. Tu pedido final sigue llegando por WhatsApp exactamente como hasta ahora.
                    </div>
                  </div>
                )}

                <div className="selection-summary">
                  Marca fotos mientras recorres el carrusel y envialas juntas cuando quieras.
                </div>

                {activeAlbumImages.length > 1 && (
                  <div className="modal-thumb-row">
                    {activeAlbumImages.map((image, index) => (
                      <button
                        key={image.id}
                        type="button"
                        className={`thumb-button ${
                          index === modalIndex || isPhotoSelected(image.id) ? 'active' : ''
                        }`}
                        onClick={() => setModalIndex(index)}
                      >
                        <img src={thumbSrc(image)} alt={image.label || `Miniatura ${index + 1}`} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
