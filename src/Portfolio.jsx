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
const PORTFOLIO_VACIO = false;
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

export default function Portfolio({ mode = 'gallery' }) {
  const isShop = mode === 'shop';
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
        const settingsSnapshot = await getDoc(getAdminSettingsRef());

        // El portfolio (gallery) arranca vacio a proposito: solo mostramos la
        // estructura profesional. Para activar tus fotos, cambia PORTFOLIO_VACIO a false.
        // La tienda (shop) siempre muestra sus fotos.
        let docs = [];
        if (isShop || !PORTFOLIO_VACIO) {
          const snapshot = await getDocs(isShop ? getShopPhotosQuery() : getPublicPhotosQuery());
          docs = snapshot.docs
            .map((docItem) => {
              const photo = normalizePhoto(docItem.id, docItem.data());
              // Portfolio limpio: sin marca de agua (no es material de venta).
              if (!isShop && photo.cleanUrl) {
                return {
                  ...photo,
                  url: photo.cleanUrl,
                  imageUrl: photo.cleanUrl,
                  thumbUrl: photo.cleanThumbUrl || photo.cleanUrl,
                };
              }
              return photo;
            })
            .filter((img) => Boolean(img.url))
            .filter((img) => (isShop ? img.isForSale !== false : true));
        }

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
    const shopTitle = 'Comprar fotos | ' + baseTitle;
    if (isShop) {
      document.title = selectedCategory ? selectedCategory + ' — ' + shopTitle : shopTitle;
    } else {
      document.title = selectedCategory ? selectedCategory + ' — ' + baseTitle : baseTitle;
    }
  }, [selectedCategory, isShop]);
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

  // Efecto cine 2026: reveal al hacer scroll (solo suma clases, no toca logica).
  useEffect(function cineReveal2026(){
    if (typeof window === "undefined") return undefined;
    function els(){ return Array.prototype.slice.call(document.querySelectorAll("[data-reveal]")); }
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      els().forEach(function(el){ el.classList.add("is-in"); });
      return undefined;
    }
    if (!("IntersectionObserver" in window)) {
      els().forEach(function(el){ el.classList.add("is-in"); });
      return undefined;
    }
    var obs = new IntersectionObserver(function(es){
      es.forEach(function(en){ if (en.isIntersecting) { en.target.classList.add("is-in"); obs.unobserve(en.target); } });
    }, { threshold: 0.12, rootMargin: "0px 0px -6% 0px" });
    els().forEach(function(el, i){ el.style.transitionDelay = Math.min(i * 60, 480) + "ms"; obs.observe(el); });
    return function(){ obs.disconnect(); };
  }, [loading, selectedCategory, selectedParentGroup, images.length]);

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
    const rqIndPlan = pricingPlanCatalog.find((qq) => qq.kind === 'individual') || chooseLowestPricePlan(pricingPlanCatalog.filter((qq) => qq.size === 1));
    const rqPackPlans = pricingPlanCatalog.filter((qq) => qq.kind === 'pack' && qq.packSize > 0);
    const rqPricing = buildPricingRecommendation(requestedImages.length, rqIndPlan, rqPackPlans);
    const rqDetail = buildPricingSummaryText(rqPricing);
    const rqTotal = rqPricing ? formatMoney(rqPricing.estimatedTotal) : '';
    const messageLines = [
      whatsAppMessage || DEFAULT_WHATSAPP_MESSAGE,
      '',
      `Categorias: ${categoryList.join(', ')}`,
      ...(eventList.length > 0 ? [`Eventos: ${eventList.join(', ')}`] : []),
      `Cantidad: ${requestedImages.length} foto(s)`,
      ...(rqTotal ? [`Total estimado: ${rqTotal}`] : []),
      ...(rqDetail ? [`Detalle: ${rqDetail}`] : []),
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
        minHeight: '100vh',
        background: '#08080a',
        color: '#f3efe6',
        fontFamily:
          'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      <style>{`
/* ===== PORTFOLIO 2026 · sistema editorial / galeria ===== */
        * { box-sizing: border-box; }
        body { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
        img { -webkit-user-drag: none; user-select: none; }
        html { scroll-behavior: smooth; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }
        @keyframes floatIn { from{opacity:0;transform:translateY(16px)} to{opacity:1;transform:translateY(0)} }
        @keyframes modalIn { from{opacity:0;transform:translateY(10px) scale(0.99)} to{opacity:1;transform:translateY(0) scale(1)} }
        @keyframes fadeIn { from{opacity:0} to{opacity:1} }
        @keyframes grainShift {
          0%,100%{transform:translate(0,0)} 10%{transform:translate(-5%,-5%)}
          20%{transform:translate(-10%,5%)} 30%{transform:translate(5%,-10%)}
          40%{transform:translate(-5%,10%)} 50%{transform:translate(-10%,5%)}
          60%{transform:translate(10%,0)} 70%{transform:translate(0,10%)}
          80%{transform:translate(5%,5%)} 90%{transform:translate(-5%,5%)}
        }
        @keyframes sweepIn { from{opacity:0;transform:translateY(26px)} to{opacity:1;transform:translateY(0)} }
        @keyframes glowPulse { 0%,100%{box-shadow:0 0 0 0 rgba(201,168,106,0)} 50%{box-shadow:0 0 24px 2px rgba(201,168,106,0.28)} }

        /* Capa de grano de pelcula + vieta cinematografica (no bloquea clicks) */
        .cine-grain, .cine-vignette { position:fixed; inset:0; pointer-events:none; z-index:55; }
        .cine-grain {
          opacity:0.05; mix-blend-mode:overlay;
          background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
          animation:grainShift 0.9s steps(4) infinite;
        }
        .cine-vignette { background:radial-gradient(120% 100% at 50% 45%, transparent 55%, rgba(0,0,0,0.55) 100%); }

        /* Reveal al entrar en pantalla */
        .reveal { opacity:0; transform:translateY(26px); }
        .reveal.is-in { animation:sweepIn 0.8s cubic-bezier(0.16,1,0.3,1) forwards; }

        /* Brillos y transiciones cinematograficas */
        .request-button, .category-card, .hero-carousel-card { will-change:transform; }
        .category-card { animation-fill-mode:both; }
        .brand-mark { animation:glowPulse 6s ease-in-out infinite; }
        .hero-carousel-card img { transition:transform 1.2s cubic-bezier(0.16,1,0.3,1), filter 0.6s ease; }
        .hero-carousel-slide.is-current .hero-carousel-card img:hover { transform:scale(1.03); }

        @media (prefers-reduced-motion: reduce) {
          .cine-grain, .brand-mark { animation:none !important; }
          .reveal { opacity:1 !important; transform:none !important; animation:none !important; }
        }

        .portfolio-shell { width:100%; max-width:none; margin:0; padding:0 0 40px; }
        .glass-frame {
          width:100%; max-width:1440px; margin:0 auto; padding:0 clamp(18px,4vw,44px);
          border:none; background:transparent; box-shadow:none; border-radius:0;
          overflow:visible; position:relative;
        }

        .top-nav {
          position:sticky; top:0; z-index:40; display:flex; align-items:center;
          justify-content:space-between; gap:20px; padding:18px 0;
          border-bottom:1px solid rgba(243,239,230,0.08);
          background:rgba(10,10,11,0.74); backdrop-filter:blur(14px);
        }
        .brand { display:flex; align-items:center; gap:14px; }
        .brand-mark {
          width:40px; height:40px; border-radius:4px; display:grid; place-items:center;
          background:linear-gradient(135deg,#c9a86a,#8a6d3b); color:#14100a;
          font-family:'Fraunces',Georgia,serif; font-weight:600; font-size:1.05rem;
        }
        .brand-copy strong {
          display:block; font-family:'Fraunces',Georgia,serif; font-size:0.98rem;
          letter-spacing:0.06em; text-transform:uppercase; color:#f3efe6;
        }
        .brand-copy span { display:block; margin-top:3px; font-size:0.78rem; color:rgba(243,239,230,0.5); }
        .nav-links { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }

        .request-button, .ghost-button, .select-chip, .thumb-button {
          transition:transform 0.2s ease, box-shadow 0.2s ease, opacity 0.2s ease,
            border-color 0.2s ease, background 0.2s ease;
        }
        .request-button {
          border:1px solid transparent; border-radius:2px; padding:12px 20px;
          background:#c9a86a; color:#14100a; font-weight:600; font-size:0.84rem;
          letter-spacing:0.05em; text-transform:uppercase; cursor:pointer; box-shadow:none;
        }
        .request-button:hover:not(:disabled){ transform:translateY(-1px); background:#d8b878; }
        .ghost-button {
          border:1px solid rgba(243,239,230,0.18); border-radius:2px; padding:10px 16px;
          background:transparent; color:rgba(243,239,230,0.86); font-weight:500;
          font-size:0.84rem; letter-spacing:0.03em; cursor:pointer;
        }
        .ghost-button:hover:not(:disabled){ border-color:rgba(243,239,230,0.42); background:rgba(243,239,230,0.04); }
        .request-button:disabled, .ghost-button:disabled, .select-chip:disabled { opacity:0.4; cursor:not-allowed; }

        .nav-contact { position:relative; }
        .contact-toggle {
          border:1px solid rgba(243,239,230,0.14); border-radius:2px; padding:10px 16px;
          background:transparent; color:rgba(243,239,230,0.82); font-size:0.82rem;
          letter-spacing:0.05em; text-transform:uppercase; cursor:pointer;
          text-decoration:none; display:inline-flex; align-items:center;
        }
        .contact-toggle:hover { border-color:rgba(243,239,230,0.34); color:#f3efe6; }
        .contact-toggle.is-active { border-color:#c9a86a; color:#e9d9b6; background:rgba(201,168,106,0.08); }
        .contact-toggle.shop-cta { border-color:rgba(127,214,166,0.4); color:#bff0d6; }
        .contact-toggle.shop-cta.is-active { background:rgba(127,214,166,0.1); }
        .shop-hero-cta { display:inline-flex; margin-top:26px; text-decoration:none; }

        .contact-popover {
          position:absolute; top:calc(100% + 12px); right:0; width:min(340px,calc(100vw - 32px));
          padding:18px; border-radius:4px; border:1px solid rgba(243,239,230,0.12);
          background:rgba(16,16,18,0.97); box-shadow:0 30px 70px rgba(0,0,0,0.5); z-index:60;
        }
        .contact-popover h3 { margin:0; font-family:'Fraunces',Georgia,serif; font-size:1.05rem; font-weight:500; color:#f3efe6; }
        .contact-popover p { margin:8px 0 0; color:rgba(243,239,230,0.6); font-size:0.86rem; line-height:1.55; }
        .contact-textarea {
          width:100%; min-height:96px; margin-top:14px; padding:12px; border-radius:2px;
          border:1px solid rgba(243,239,230,0.12); background:rgba(243,239,230,0.03);
          color:#f3efe6; font:inherit; font-size:0.9rem; resize:vertical;
        }

        /* ---------------- HERO ---------------- */
        .hero {
          display:grid; grid-template-columns:minmax(280px,0.9fr) minmax(0,1.1fr);
          gap:clamp(28px,4vw,64px); padding:clamp(36px,6vw,84px) 0 clamp(28px,4vw,52px);
          align-items:center;
        }
        .hero-copy { text-align:left; align-self:center; }
        .eyebrow {
          display:inline-flex; align-items:center; gap:12px; margin-bottom:22px; padding:0;
          background:transparent; border:none; font-size:0.72rem; letter-spacing:0.3em;
          text-transform:uppercase; color:rgba(243,239,230,0.55);
        }
        .eyebrow::before { content:''; width:34px; height:1px; background:#c9a86a; }
        .hero h1 {
          margin:0; font-family:'Fraunces',Georgia,serif; font-optical-sizing:auto; font-weight:400;
          font-size:clamp(2.8rem,7vw,5.6rem); line-height:1; letter-spacing:-0.02em; color:#f3efe6;
        }
        .hero p {
          max-width:40ch; margin:24px 0 0; color:rgba(243,239,230,0.62);
          font-size:1rem; line-height:1.85; font-weight:300;
        }
        .shop-how { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-top:26px; }
        .shop-how-step { padding:16px; border:1px solid rgba(243,239,230,0.1); border-radius:2px; background:rgba(243,239,230,0.02); }
        .shop-how-step b { display:block; font-size:0.8rem; letter-spacing:0.06em; color:#bff0d6; }
        .shop-how-step span { display:block; margin-top:6px; font-size:0.82rem; color:rgba(243,239,230,0.55); line-height:1.5; }

        .hero-showcase { display:flex; flex-direction:column; gap:16px; min-width:0; max-width:560px; width:100%; }
        .hero-showcase.is-hidden { display:none; }
        .hero-visual {
          position:relative; width:100%; min-height:clamp(220px,26vw,340px); padding:0;
          border:1px solid rgba(243,239,230,0.1); border-radius:2px; overflow:hidden;
          background:#141416; isolation:isolate;
        }
        .hero-visual::before { display:none; }
        .hero-carousel-stage {
          position:relative; display:grid; grid-template-columns:1fr; width:100%;
          height:100%; min-height:inherit; isolation:isolate;
        }
        .hero-carousel-slide { position:relative; grid-column:1; display:flex; align-items:center; justify-content:center; min-width:0; }
        .hero-carousel-slide.is-prev, .hero-carousel-slide.is-next { display:none; }
        .hero-carousel-card { position:relative; width:100%; height:100%; min-height:clamp(220px,26vw,340px); overflow:hidden; border-radius:2px; }
        .hero-empty-frame {
          width: 100%; height: 100%; min-height: inherit;
          display: flex; flex-direction: column; align-items: center; justify-content: center;
          gap: 10px; padding: 40px 24px; text-align: center;
          background:
            repeating-linear-gradient(45deg, rgba(243,239,230,0.02) 0 12px, transparent 12px 24px),
            #101012;
          border: 1px dashed rgba(201,168,106,0.32); border-radius: 2px;
        }
        .hero-empty-mark {
          width: 54px; height: 54px; border-radius: 4px; display: grid; place-items: center;
          background: linear-gradient(135deg,#c9a86a,#8a6d3b); color:#14100a;
          font-family:'Fraunces',Georgia,serif; font-weight:600; font-size:1.2rem;
        }
        .hero-empty-text {
          font-family:'Fraunces',Georgia,serif; font-size:1.2rem; color:#f3efe6; margin-top:6px;
        }
        .hero-empty-sub { font-size:0.86rem; color:rgba(243,239,230,0.5); }
        .hero-carousel-card img { width:100%; height:100%; object-fit:cover; display:block; filter:none; }

        .hero-category-strip { display:flex; gap:8px; flex-wrap:wrap; }
        .hero-category-pill {
          display:inline-flex; align-items:center; gap:8px; padding:9px 14px; border-radius:2px;
          border:1px solid rgba(243,239,230,0.12); background:transparent;
          color:rgba(243,239,230,0.66); font-size:0.8rem; letter-spacing:0.04em; cursor:pointer;
        }
        .hero-category-pill small { color:rgba(243,239,230,0.4); font-size:0.72rem; }
        .hero-category-pill.is-active { border-color:#c9a86a; color:#f3efe6; background:rgba(201,168,106,0.08); }

        .hero-stage-caption { display:flex; align-items:center; justify-content:space-between; gap:16px; flex-wrap:wrap; padding-top:4px; }
        .hero-stage-caption-copy { display:flex; flex-direction:column; gap:4px; }
        .hero-stage-kicker { color:rgba(243,239,230,0.45); font-size:0.72rem; letter-spacing:0.2em; text-transform:uppercase; }
        .hero-stage-caption strong { font-family:'Fraunces',Georgia,serif; font-weight:400; font-size:1.05rem; color:#f3efe6; }

        /* ---------------- SECCIONES / TARJETAS DE EVENTO ---------------- */
        .section { padding:clamp(28px,4vw,48px) 0; }
        .compact-header { margin-bottom:26px; }
        .back-button {
          border:1px solid rgba(243,239,230,0.16); border-radius:2px; padding:9px 16px;
          background:transparent; color:rgba(243,239,230,0.72); font-size:0.82rem;
          letter-spacing:0.04em; cursor:pointer; text-transform:uppercase;
        }
        .back-button:hover { border-color:rgba(243,239,230,0.4); color:#f3efe6; }
        .compact-copy h2 {
          margin:16px 0 0; font-family:'Fraunces',Georgia,serif; font-weight:400;
          font-size:clamp(1.9rem,4vw,3rem); line-height:1.05; letter-spacing:-0.01em; color:#f3efe6;
        }
        .compact-copy p { margin:14px 0 0; color:rgba(243,239,230,0.58); line-height:1.7; max-width:60ch; font-weight:300; }

        .category-grid {
          display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); justify-content:center;
          gap:clamp(16px,2vw,26px);
        }
        .category-grid.is-expanded { grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); justify-content:center; }
        .category-card {
          position:relative; display:flex; flex-direction:column; text-align:left;
          padding:0; border:1px solid rgba(243,239,230,0.1); border-radius:3px;
          background:#101012; cursor:pointer; overflow:hidden;
          transition:transform 0.3s ease, border-color 0.3s ease, box-shadow 0.3s ease;
        }
        .category-card:hover {
          transform:translateY(-4px); border-color:rgba(201,168,106,0.42);
          box-shadow:0 24px 50px rgba(0,0,0,0.4);
        }
        .category-card.is-active { border-color:rgba(201,168,106,0.7); }
        .card-media { position:relative; overflow:hidden; width:100%; aspect-ratio:16/10; background:#151517; }
        .card-media img { width:100%; height:100%; object-fit:cover; display:block; transition:transform 0.6s cubic-bezier(0.2,0.7,0.2,1); }
        .category-card:hover .card-media img, .photo-card:hover .card-media img { transform:scale(1.06); }
        .category-card.is-active .card-media img { transform:scale(1.08); }
        .category-label {
          padding:16px 18px 18px; color:#f3efe6; font-family:'Fraunces',Georgia,serif;
          font-weight:400; font-size:1.12rem; display:flex; align-items:center;
          justify-content:space-between; gap:10px;
        }

        .badge {
          display:inline-flex; align-items:center; padding:5px 11px; border-radius:2px;
          border:1px solid rgba(243,239,230,0.14); background:rgba(243,239,230,0.03);
          color:rgba(243,239,230,0.74); font-size:0.74rem; letter-spacing:0.04em;
        }
        .badge-gold { border-color:rgba(201,168,106,0.5); color:#e9d9b6; background:rgba(201,168,106,0.08); }

        .selection-summary {
          padding:18px 20px; border:1px solid rgba(243,239,230,0.12); border-radius:3px;
          background:rgba(243,239,230,0.03); color:rgba(243,239,230,0.82);
          font-size:0.92rem; line-height:1.6;
        }

        .footer {
          margin-top:clamp(40px,6vw,80px); padding-top:32px; border-top:1px solid rgba(243,239,230,0.08);
          display:flex; justify-content:space-between; gap:24px; flex-wrap:wrap;
        }

        /* ---------------- MODAL / LIGHTBOX (blur obligatorio) ---------------- */
        .modal-overlay {
          position:fixed; inset:0; z-index:60; display:flex; align-items:flex-start;
          justify-content:center; padding:22px; background:rgba(4,4,5,0.86);
          backdrop-filter:blur(16px) saturate(1.2); overflow-y:auto; overscroll-behavior:contain;
        }
        .modal-content { width:min(1260px,96vw); animation:modalIn 380ms cubic-bezier(0.16,1,0.3,1); margin:auto 0; }
        .modal-content.is-overview { width:min(1120px,96vw); }

        .modal-image-wrap {
          position:relative; border-radius:3px; overflow:hidden;
          border:1px solid rgba(243,239,230,0.1); background:#0c0c0e;
        }
        .modal-image { width:100%; max-height:78vh; object-fit:contain; display:block; }

        .modal-nav, .modal-close, .modal-select {
          position:absolute; z-index:3; color:#fff; cursor:pointer; backdrop-filter:blur(12px);
        }
        .modal-nav, .modal-close { border:none; background:rgba(10,10,10,0.48); }
        .modal-nav {
          top:50%; transform:translateY(-50%); width:52px; height:52px; border-radius:2px; font-size:1.5rem;
        }
        .modal-close { top:16px; right:16px; width:46px; height:46px; border-radius:2px; font-size:1.2rem; line-height:1; }
        .modal-select {
          top:16px; left:16px; display:inline-flex; align-items:center; gap:8px;
          border:1px solid rgba(243,239,230,0.2); background:rgba(10,10,10,0.52);
          border-radius:2px; padding:10px 14px; font-size:0.88rem; font-weight:600;
        }
        .modal-select.active { background:rgba(31,107,79,0.86); border-color:rgba(121,217,173,0.66); }
        .modal-select-mark {
          display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px;
          border-radius:999px; border:1px solid rgba(255,255,255,0.42); font-size:0.72rem; line-height:1; flex:0 0 auto;
        }

        .modal-info {
          display:flex; flex-direction:column; align-items:center; gap:14px; padding:18px 12px 0; text-align:center;
        }
        .modal-overview { padding:20px; }
        .modal-overview-top { display:flex; justify-content:space-between; align-items:flex-start; gap:14px; }
        .modal-overview-copy { display:flex; flex-direction:column; gap:8px; text-align:left; }
        .modal-overview-kicker { color:rgba(243,239,230,0.54); font-size:0.8rem; letter-spacing:0.2em; text-transform:uppercase; }
        .modal-overview-title {
          margin:0; font-family:'Fraunces',Georgia,serif; font-optical-sizing:auto;
          font-size:clamp(1.3rem,2vw,1.8rem); font-weight:400; color:#f3efe6;
        }
        .modal-overview-meta {
          display:flex; align-items:center; gap:10px; flex-wrap:wrap;
          color:rgba(243,239,230,0.62); font-size:0.9rem;
        }
        .modal-overview-grid {
          display:grid; grid-template-columns:repeat(auto-fill,minmax(160px,1fr)); gap:14px; margin-top:18px;
        }
        .modal-overview-card {
          position:relative; border:1px solid rgba(243,239,230,0.1); border-radius:3px; overflow:hidden;
          padding:0; background:#101012; cursor:pointer; box-shadow:0 16px 30px rgba(0,0,0,0.24);
          transition:transform 220ms ease, box-shadow 220ms ease, border-color 220ms ease;
        }
        .modal-overview-card:hover {
          transform:translateY(-6px); box-shadow:0 24px 48px rgba(0,0,0,0.3); border-color:rgba(201,168,106,0.55);
        }
        .modal-overview-card.active { border-color:rgba(201,168,106,0.82); box-shadow:0 0 0 2px rgba(201,168,106,0.2); }
        .modal-overview-card img {
          width:100%; height:180px; object-fit:cover; display:block;
          background:rgba(255,255,255,0.05);
        }
        .modal-overview-card-index {
          position:absolute; top:10px; left:10px; min-width:28px; height:28px; padding:0 8px; border-radius:2px;
          display:inline-flex; align-items:center; justify-content:center; background:rgba(10,10,10,0.6);
          color:#f3efe6; font-size:0.78rem; font-weight:700; backdrop-filter:blur(10px);
        }
        .modal-overview-card.active .modal-overview-card-index { background:rgba(201,168,106,0.94); color:#1c1306; }
        .modal-overview-card-label { padding:10px 12px 12px; color:rgba(243,239,230,0.86); font-size:0.85rem; font-weight:600; text-align:left; }

        .modal-title { margin:0; font-size:1.08rem; font-weight:600; font-family:'Fraunces',Georgia,serif; }
        .modal-sub { color:rgba(243,239,230,0.54); font-size:0.92rem; }

        .modal-actions, .modal-thumb-row {
          display:flex; align-items:center; justify-content:center; gap:10px; flex-wrap:wrap;
        }
        .modal-thumb-row { margin-top:4px; overflow-x:auto; padding:6px 2px 2px; }
        .thumb-button {
          width:72px; height:72px; border-radius:3px; overflow:hidden; border:1px solid rgba(243,239,230,0.1);
          padding:0; background:rgba(255,255,255,0.05); cursor:pointer; flex:0 0 auto; position:relative;
          box-shadow:0 14px 28px rgba(0,0,0,0.18);
        }
        /* ===== TIENDA: identidad verde, distinta al portfolio ambar ===== */
        .portfolio-shell.is-shop {
          background:
            radial-gradient(circle at 16% 46%, rgba(22,101,63,0.16), transparent 30%),
            #060a08;
        }
        .portfolio-shell.is-shop .brand-mark { background:linear-gradient(135deg,#34c98a,#1f6b4f); color:#04140d; }
        .portfolio-shell.is-shop .eyebrow { color:#bff0d6; }
        .portfolio-shell.is-shop .eyebrow::before { background:#34c98a; }
        .portfolio-shell.is-shop .hero-category-pill.is-active { border-color:rgba(52,168,120,0.5); color:#eafff4; background:rgba(31,107,79,0.16); }
        .portfolio-shell.is-shop .hero-dot.is-active { background:linear-gradient(90deg,#34c98a,#1f6b4f); }
        .portfolio-shell.is-shop .hero-stage-caption strong { color:#eafff4; }
        .portfolio-shell.is-shop .request-button { background:#1f6b4f; color:#effaf4; }
        .portfolio-shell.is-shop .request-button:hover:not(:disabled) { background:#28865c; }
        .portfolio-shell.is-shop .contact-toggle.is-active { border-color:rgba(52,168,120,0.5); color:#bff0d6; background:rgba(31,107,79,0.12); }
        .portfolio-shell.is-shop .category-card:hover { border-color:rgba(52,168,120,0.45); }
        .portfolio-shell.is-shop .category-card.is-active { border-color:rgba(52,168,120,0.7); }
        .portfolio-shell.is-shop .badge-gold { border-color:rgba(52,168,120,0.5); color:#bff0d6; background:rgba(31,107,79,0.12); }
        .portfolio-shell.is-shop .modal-overview-card:hover { border-color:rgba(52,168,120,0.55); }
        .portfolio-shell.is-shop .modal-overview-card.active { border-color:rgba(52,168,120,0.82); box-shadow:0 0 0 2px rgba(52,168,120,0.2); }
        .portfolio-shell.is-shop .modal-overview-card.active .modal-overview-card-index { background:rgba(52,168,120,0.94); color:#04140d; }
        .portfolio-shell.is-shop .thumb-button.active { border-color:rgba(52,168,120,0.8); box-shadow:0 0 0 2px rgba(52,168,120,0.18); }

        /* ===== RESPONSIVE ===== */
        @media (max-width: 1120px) {
          .hero { grid-template-columns:1fr; justify-items:center; }
          .hero-copy { text-align:center; max-width:760px; padding-top:0; }
          .hero p { margin-left:auto; margin-right:auto; max-width:660px; }
          .hero-showcase { width:100%; max-width:none; }
          .eyebrow::before { display:none; }
        }
        @media (max-width: 780px) {
          .portfolio-shell { width:100%; padding-top:10px; }
          .glass-frame { padding:0 18px; }
          .top-nav { flex-direction:column; align-items:flex-start; }
          .nav-links { width:100%; justify-content:space-between; }
          .nav-contact { width:100%; }
          .contact-toggle { width:100%; justify-content:center; }
          .contact-popover { left:0; right:auto; width:100%; }
          .request-button { width:100%; justify-content:center; }
          .shop-how { grid-template-columns:1fr; }
          .category-grid, .category-grid.is-expanded { grid-template-columns:1fr; }
          .modal-overview { padding:14px; }
          .modal-overview-grid { grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
          .modal-overview-card img { height:140px; }
          .thumb-button { width:62px; height:62px; }
          .modal-nav { width:42px; height:42px; }
          .modal-select { top:12px; left:12px; }
          .modal-close { top:12px; right:12px; }
          .compact-header { align-items:flex-start; }
          .hero { gap:16px; padding-top:24px; padding-bottom:16px; justify-items:stretch; }
          .hero h1 { font-size:clamp(2.2rem,11vw,3.4rem); }
          .hero-copy { text-align:center; max-width:760px; }
          .hero-visual { min-height:clamp(300px,72vw,500px); }
          .footer { flex-direction:column; }
        }

        .thumb-button.active { border-color:rgba(201,168,106,0.8); box-shadow:0 0 0 2px rgba(201,168,106,0.18); }
        .thumb-button:not(.active):hover { transform:translateY(-1px); border-color:rgba(243,239,230,0.2); }
        .thumb-button img { width:100%; height:100%; object-fit:cover; display:block; }

        .footer-copy {
          color:rgba(243,239,230,0.5); font-size:0.86rem; line-height:1.6;
        }
        .footer-socials { display:flex; gap:18px; margin-top:10px; }
        .footer-socials a { color:rgba(243,239,230,0.7); text-decoration:none; border-bottom:1px solid transparent; }
        .footer-socials a:hover { color:#f3efe6; border-color:rgba(201,168,106,0.6); }

        .hero-dots { display:flex; gap:6px; }
        .hero-dot { width:22px; height:2px; border:none; padding:0; background:rgba(243,239,230,0.2); cursor:pointer; }
        .hero-dot.is-active { background:#c9a86a; }
        .hero-stage-meta { display:flex; gap:16px; color:rgba(243,239,230,0.5); font-size:0.78rem; letter-spacing:0.04em; }

        }
        .contact-textarea:focus { outline:none; border-color:#c9a86a; }
        .contact-actions { display:flex; gap:10px; flex-wrap:wrap; margin-top:14px; }
        .contact-actions .request-button, .contact-actions .ghost-button { flex:1 1 0; }
        .contact-mini { margin-top:12px; color:rgba(243,239,230,0.46); font-size:0.8rem; line-height:1.5; }
        `}</style>

      <div className={'portfolio-shell' + (isShop ? ' is-shop' : '')}>
        <div className="cine-grain" aria-hidden="true"></div>
          <div className="cine-vignette" aria-hidden="true"></div>
          <div className="glass-frame">
          <div className="top-nav">
            <div className="brand">
              <div className="brand-mark">CP</div>
            <div className="brand-copy">
                <span>Eventos, retratos, paisajes y escena en vivo</span>
              </div>
            </div>

            <div className="nav-links">
              <Link to="/" className={'contact-toggle' + (!isShop ? ' is-active' : '')} onClick={returnToPortfolio}>
                Portfolio
              </Link>
              <Link to="/tienda" className={'contact-toggle shop-cta' + (isShop ? ' is-active' : '')}>
                Comprar fotos
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
              {isShop && selectedCategory && !modalImage && (
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
              <div className="eyebrow">{isShop ? 'Tienda' : 'Portfolio'}</div>
              <h1>{isShop ? 'Comprar fotos' : (adminName || 'César Dario')}</h1>
              <p>
                {isShop
                  ? 'Elegi tus fotos favoritas, marcalas y pedilas por WhatsApp. Los precios se calculan solos a medida que seleccionas.'
                  : 'Fotografia de eventos, retratos y escenas en vivo. Trabajo en bodas, 15 años, books, paisajes, playa, recitales, cuarteto, boliches y proyectos visuales de todo tipo.'}
              </p>
              {isShop && (
                <div className="shop-how">
                  <div className="shop-how-step">
                    <b>1. Elegí</b>
                    <span>Abrí un evento y mirá la galería.</span>
                  </div>
                  <div className="shop-how-step">
                    <b>2. Marcá</b>
                    <span>Tocá las fotos que te gusten. El precio se calcula solo.</span>
                  </div>
                  <div className="shop-how-step">
                    <b>3. Pedilas</b>
                    <span>Enviá tu selección por WhatsApp y cerramos el pedido.</span>
                  </div>
                </div>
              )}
              {!isShop && (
                <Link to="/tienda" className="request-button shop-hero-cta">
                  Comprar fotos
                </Link>
              )}
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
                  <div className="hero-empty-frame">
                    <span className="hero-empty-mark">CP</span>
                    <span className="hero-empty-text">Tu portada aparecera aqui</span>
                    <span className="hero-empty-sub">Subi tus fotos y marca una como portada</span>
                  </div>
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
                      : isShop
                        ? `${activeCategory.albums.length} evento(s) dentro de esta categoria. Abri un evento, marca las fotos que te gusten y pedilas por WhatsApp.`
                        : `${activeCategory.albums.length} evento(s) dentro de esta categoria. Abri un evento para ver su galeria completa.`}
                  </p>
                </div>
              </div>

              {isShop && selectedPhotoIds.length > 0 && (
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
            {isShop && !selectedCategory && (
              <div
                className="selection-summary"
                style={{
                  marginBottom: '18px',
                  padding: '16px 18px',
                  border: '1px solid rgba(240, 212, 155, 0.22)',
                  borderRadius: '18px',
                  background: 'linear-gradient(180deg, rgba(240,212,155,0.08), rgba(255,255,255,0.03))',
                  backdropFilter: 'blur(14px)',
                }}
              >
                <div style={{ fontSize: '0.76rem', letterSpacing: '0.18em', textTransform: 'uppercase', opacity: 0.68 }}>
                  Como comprar
                </div>
                <div style={{ marginTop: '8px', opacity: 0.9, lineHeight: 1.6 }}>
                  1. Recorre las categorias y abri un evento. 2. Marca tus fotos favoritas (los precios se calculan solos). 3. Pedi todo junto por WhatsApp.
                </div>
                {selectedPhotoIds.length > 0 && pricingRecommendation && (
                  <div style={{ marginTop: '12px', display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
                    <span className="badge badge-gold">
                      {selectedPhotoIds.length} foto{selectedPhotoIds.length === 1 ? '' : 's'} · {formatMoney(pricingRecommendation.estimatedTotal)}
                    </span>
                    <span style={{ fontSize: '0.9rem', opacity: 0.82 }}>{pricingSummaryText}</span>
                  </div>
                )}
              </div>
            )}
            {isShop && !selectedCategory && serviceShowcaseText ? (
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
              <div className="category-grid reveal" data-reveal>
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
                          className={`modal-overview-card ${isShop && isActive ? 'active' : ''}`}
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
                />

                {isShop && (
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
                )}

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
                  {isShop && selectedPhotoIds.length > 0 && (
                    <span className="badge">{selectedPhotoIds.length} seleccionada(s)</span>
                  )}
                </div>

                {isShop && (
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
                )}

                {isShop && selectedPhotoIds.length > 0 && pricingRecommendation && (
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

                {isShop && (
                <div className="selection-summary">
                  Marca fotos mientras recorres el carrusel y envialas juntas cuando quieras.
                </div>
                )}

                {activeAlbumImages.length > 1 && (
                  <div className="modal-thumb-row">
                    {activeAlbumImages.map((image, index) => (
                      <button
                        key={image.id}
                        type="button"
                        className={`thumb-button ${
                          index === modalIndex || (isShop && isPhotoSelected(image.id)) ? 'active' : ''
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
