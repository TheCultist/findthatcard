"use client";

import { CardResult, CardDetailData } from "@/types/scryfall";
import { useEffect, useState, useCallback, useRef } from "react";
import Image from "next/image";
import ManaCost from "@/app/components/ManaCost";
import OracleText from "@/app/components/OracleText";
import KeywordWithTooltip from "@/app/components/KeywordWithTooltip";
import {
  XMarkIcon,
  ArrowTopRightOnSquareIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "@heroicons/react/24/outline";
import { getCardTraderLink, getCardTraderHomepageLink } from "@/lib/cardtrader/links";

interface CardDetailPanelProps {
  card: CardResult;
  onClose: () => void;
  /** Position of `card` within the result set, used for the counter and animations. */
  index?: number;
  total?: number;
  onPrev?: () => void;
  onNext?: () => void;
  /** Ids of the neighbouring cards, prefetched so navigation feels instant. */
  prevCardId?: string | null;
  nextCardId?: string | null;
}

/**
 * Card details are immutable for a given Scryfall id, so they are cached for the
 * lifetime of the page. This keeps prev/next navigation instant and lets us warm
 * the neighbours of the card currently on screen.
 */
const detailCache = new Map<string, CardDetailData>();
const inflightDetails = new Map<string, Promise<CardDetailData | null>>();

function fetchCardDetail(id: string): Promise<CardDetailData | null> {
  const cached = detailCache.get(id);
  if (cached) return Promise.resolve(cached);

  const inflight = inflightDetails.get(id);
  if (inflight) return inflight;

  const request = (async () => {
    try {
      const response = await fetch(`/api/card/${id}`);
      if (!response.ok) return null;
      const data: CardDetailData = await response.json();
      detailCache.set(id, data);
      return data;
    } catch (err) {
      console.error("[CardDetailPanel] Failed to fetch card details:", err);
      return null;
    } finally {
      inflightDetails.delete(id);
    }
  })();

  inflightDetails.set(id, request);
  return request;
}

/** Horizontal distance (px) a swipe must cover before it commits to a navigation. */
const SWIPE_COMMIT_PX = 60;
/** Movement (px) before a gesture locks to either the horizontal or vertical axis. */
const AXIS_LOCK_PX = 8;

const RARITY_COLORS: Record<string, string> = {
  common: "text-gray-500 dark:text-gray-400",
  uncommon: "text-slate-400 dark:text-slate-300",
  rare: "text-yellow-500 dark:text-yellow-400",
  mythic: "text-orange-500 dark:text-orange-400",
  special: "text-purple-500 dark:text-purple-400",
  bonus: "text-purple-500 dark:text-purple-400",
};

const LEGALITY_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  legal: { bg: "bg-green-100/60 border-green-300/50 dark:bg-green-900/60 dark:border-green-700/50", text: "text-green-700 dark:text-green-300", label: "Legal" },
  not_legal: { bg: "bg-surface-muted border-border", text: "text-muted", label: "Not Legal" },
  banned: { bg: "bg-red-100/60 border-red-300/50 dark:bg-red-900/60 dark:border-red-700/50", text: "text-red-700 dark:text-red-400", label: "Banned" },
  restricted: { bg: "bg-yellow-100/60 border-yellow-300/50 dark:bg-yellow-900/60 dark:border-yellow-700/50", text: "text-yellow-700 dark:text-yellow-400", label: "Restricted" },
};

const KEY_FORMATS = [
  { key: "standard", label: "Standard" },
  { key: "pioneer", label: "Pioneer" },
  { key: "modern", label: "Modern" },
  { key: "legacy", label: "Legacy" },
  { key: "vintage", label: "Vintage" },
  { key: "commander", label: "Commander" },
  { key: "pauper", label: "Pauper" },
  { key: "historic", label: "Historic" },
  { key: "explorer", label: "Explorer" },
  { key: "alchemy", label: "Alchemy" },
  { key: "brawl", label: "Brawl" },
  { key: "oathbreaker", label: "Oathbreaker" },
];

function capitalize(str: string) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function CardFaceView({ face }: {
  face: {
    name: string;
    mana_cost?: string;
    type_line?: string;
    oracle_text?: string;
    flavor_text?: string;
    power?: string;
    toughness?: string;
    loyalty?: string;
    defense?: string;
    artist?: string;
  };
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-base font-bold text-foreground">{face.name}</h3>
        {face.mana_cost && (
          <div className="flex-shrink-0 mt-0.5">
            <ManaCost manaCost={face.mana_cost} />
          </div>
        )}
      </div>

      {face.type_line && (
        <p className="text-xs font-medium text-muted uppercase tracking-wide border-b border-border pb-2">
          {face.type_line}
        </p>
      )}

      {face.oracle_text && (
        <OracleText text={face.oracle_text} />
      )}

      {face.flavor_text && (
        <OracleText text={face.flavor_text} italic className="border-t border-border pt-2" />
      )}

      {(face.power !== undefined || face.toughness !== undefined) && (
        <p className="text-sm font-bold text-foreground text-right">
          {face.power}/{face.toughness}
        </p>
      )}
      {face.loyalty !== undefined && (
        <p className="text-sm font-bold text-foreground text-right">
          Loyalty: {face.loyalty}
        </p>
      )}
      {face.defense !== undefined && (
        <p className="text-sm font-bold text-foreground text-right">
          Defense: {face.defense}
        </p>
      )}
    </div>
  );
}

export default function CardDetailPanel({
  card,
  onClose,
  index = 0,
  total = 1,
  onPrev,
  onNext,
  prevCardId = null,
  nextCardId = null,
}: CardDetailPanelProps) {
  const [detailData, setDetailData] = useState<CardDetailData | null>(
    () => detailCache.get(card.id) ?? null
  );
  const [loading, setLoading] = useState(() => !detailCache.has(card.id));
  const [activeFace, setActiveFace] = useState(0);
  const [isCheckingLink, setIsCheckingLink] = useState(false);
  const [visible, setVisible] = useState(false);
  const [dragY, setDragY] = useState(0);
  const [dragX, setDragX] = useState(0);
  /** "settling" animates the body back to rest after a swipe that did not commit. */
  const [swipeState, setSwipeState] = useState<"idle" | "dragging" | "settling">("idle");
  const [isSwipingAway, setIsSwipingAway] = useState(false);
  /** Direction of the most recent navigation, so the incoming card slides in from the right side. */
  const [navDirection, setNavDirection] = useState<-1 | 0 | 1>(0);

  const dragStartX = useRef(0);
  const dragStartY = useRef(0);
  const dragXRef = useRef(0);
  const dragYRef = useRef(0);
  const dragAxis = useRef<"x" | "y" | null>(null);
  const dragFromHandle = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasPrev = Boolean(onPrev) && index > 0;
  const hasNext = Boolean(onNext) && index < total - 1;
  const canNavigate = hasPrev || hasNext;

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 10);
    return () => clearTimeout(t);
  }, []);

  const handleClose = useCallback(() => {
    setVisible(false);
    setTimeout(onClose, 200);
  }, [onClose]);

  const navigate = useCallback(
    (direction: -1 | 1) => {
      if (direction === -1 ? !hasPrev : !hasNext) return;
      setNavDirection(direction);
      if (direction === -1) onPrev?.();
      else onNext?.();
    },
    [hasPrev, hasNext, onPrev, onNext]
  );

  const handleDragStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    dragStartX.current = touch.clientX;
    dragStartY.current = touch.clientY;
    dragAxis.current = null;
    const target = e.target;
    dragFromHandle.current =
      target instanceof Element && Boolean(target.closest("[data-drag-handle]"));
  }, []);

  const handleDragMove = useCallback(
    (e: React.TouchEvent) => {
      const touch = e.touches[0];
      const deltaX = touch.clientX - dragStartX.current;
      const deltaY = touch.clientY - dragStartY.current;

      // Lock to a single axis on first meaningful movement: horizontal swipes
      // navigate, vertical ones either dismiss (from the handle) or scroll.
      if (dragAxis.current === null) {
        if (Math.abs(deltaX) < AXIS_LOCK_PX && Math.abs(deltaY) < AXIS_LOCK_PX) return;
        dragAxis.current = Math.abs(deltaX) > Math.abs(deltaY) ? "x" : "y";
      }

      if (dragAxis.current === "x") {
        if (!canNavigate) return;
        // Rubber-band at the ends of the result set.
        const atEnd = (deltaX > 0 && !hasPrev) || (deltaX < 0 && !hasNext);
        const offset = atEnd ? deltaX * 0.25 : deltaX;
        dragXRef.current = offset;
        setDragX(offset);
        setSwipeState("dragging");
        return;
      }

      if (!dragFromHandle.current) return;
      const delta = Math.max(0, deltaY);
      dragYRef.current = delta;
      setDragY(delta);
    },
    [canNavigate, hasPrev, hasNext]
  );

  const handleDragEnd = useCallback(() => {
    const axis = dragAxis.current;
    dragAxis.current = null;

    if (axis === "x") {
      const deltaX = dragXRef.current;
      dragXRef.current = 0;
      setDragX(0);
      const committed =
        deltaX <= -SWIPE_COMMIT_PX ? 1 : deltaX >= SWIPE_COMMIT_PX ? -1 : 0;
      if (committed) {
        // The incoming card plays its own slide-in animation.
        setSwipeState("idle");
        navigate(committed);
      } else if (deltaX !== 0) {
        setSwipeState("settling");
        if (settleTimer.current) clearTimeout(settleTimer.current);
        settleTimer.current = setTimeout(() => setSwipeState("idle"), 200);
      }
      return;
    }

    if (axis === "y" && dragFromHandle.current && dragYRef.current > 80) {
      dragYRef.current = 0;
      setIsSwipingAway(true);
      setTimeout(onClose, 220);
      return;
    }

    dragYRef.current = 0;
    setDragY(0);
  }, [navigate, onClose]);

  const handleDragCancel = useCallback(() => {
    dragAxis.current = null;
    dragXRef.current = 0;
    dragYRef.current = 0;
    setDragX(0);
    setDragY(0);
    setSwipeState("idle");
  }, []);

  useEffect(() => () => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
  }, []);

  useEffect(() => {
    const cached = detailCache.get(card.id);
    setActiveFace(0);
    if (cached) {
      setDetailData(cached);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setDetailData(null);
    setLoading(true);
    fetchCardDetail(card.id).then((data) => {
      if (cancelled) return;
      setDetailData(data);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [card.id]);

  // Warm the neighbours so arrow/swipe navigation lands on rendered details.
  useEffect(() => {
    if (prevCardId) void fetchCardDetail(prevCardId);
    if (nextCardId) void fetchCardDetail(nextCardId);
  }, [prevCardId, nextCardId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
      } else if (e.key === "ArrowLeft") {
        navigate(-1);
      } else if (e.key === "ArrowRight") {
        navigate(1);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleClose, navigate]);

  useEffect(() => {
    const { body, documentElement: root } = document;
    const prevOverflow = body.style.overflow;
    // Horizontal swipes navigate between cards, so they must not chain up to the
    // document and trigger the browser's swipe-to-go-back gesture.
    const prevOverscroll = root.style.overscrollBehaviorX;
    body.style.overflow = "hidden";
    root.style.overscrollBehaviorX = "none";
    return () => {
      body.style.overflow = prevOverflow;
      root.style.overscrollBehaviorX = prevOverscroll;
    };
  }, []);

  const handleCardTraderClick = async (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const cardtraderUrl = getCardTraderLink(
      card.name,
      card.set_name,
      card.set_code,
      card.collector_number
    );
    setIsCheckingLink(true);
    try {
      const response = await fetch(`/api/check-link?url=${encodeURIComponent(cardtraderUrl)}`);
      const data = await response.json();
      const url = data.is404 ? getCardTraderHomepageLink() : cardtraderUrl;
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      window.open(getCardTraderHomepageLink(), "_blank", "noopener,noreferrer");
    } finally {
      setIsCheckingLink(false);
    }
  };

  const getFaceImage = (): string | null => {
    if (detailData) {
      const hasFaces = detailData.card_faces && detailData.card_faces.length > 1;
      if (hasFaces) {
        const face = detailData.card_faces![activeFace];
        const faceImg = face.image_uris;
        if (faceImg) {
          return faceImg.large || faceImg.normal || faceImg.small || null;
        }
      }
      if (detailData.image_uris) {
        return detailData.image_uris.large || detailData.image_uris.normal || null;
      }
    }
    return card.image_uris.normal || card.image_uris.small || null;
  };

  const imageSrc = getFaceImage();
  const hasFaces = detailData?.card_faces && detailData.card_faces.length > 1;

  const rarityColor = detailData?.rarity
    ? (RARITY_COLORS[detailData.rarity] ?? "text-gray-400")
    : "text-gray-400";

  const tcgPlayerUrl = card.tcgplayer_link;
  const cardtraderUrl = getCardTraderLink(
    card.name,
    card.set_name,
    card.set_code,
    card.collector_number
  );

  return (
    <div
      className={`fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 transition-all duration-200 ${
        visible && !isSwipingAway ? "bg-foreground/60 backdrop-blur-sm" : "bg-transparent pointer-events-none"
      }`}
      onClick={handleClose}
    >
      <div
        className={`relative w-full sm:max-w-4xl max-h-[95dvh] sm:max-h-[90dvh] bg-surface border border-border rounded-t-2xl sm:rounded-2xl flex flex-col overflow-hidden shadow-2xl transition-all duration-200 ${
          visible
            ? "opacity-100 translate-y-0 sm:scale-100"
            : "opacity-0 translate-y-8 sm:scale-95"
        }`}
        style={{
          // Horizontal swipes are handled by us; vertical panning stays with the browser
          // so the details body can still scroll normally.
          touchAction: "pan-y",
          ...(isSwipingAway
            ? { transform: "translateY(100%)", transition: "transform 220ms ease" }
            : dragY > 0
              ? { transform: `translateY(${dragY}px)`, transition: "none", opacity: Math.max(0.4, 1 - dragY / 400) }
              : null),
        }}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={handleDragStart}
        onTouchMove={handleDragMove}
        onTouchEnd={handleDragEnd}
        onTouchCancel={handleDragCancel}
      >
        <div
          className="sm:hidden flex justify-center pt-3 pb-1 flex-shrink-0 select-none"
          style={{ touchAction: "none" }}
          data-drag-handle
        >
          <div className="h-1.5 w-12 rounded-full bg-border" />
        </div>

        <div
          className="flex items-center gap-2 px-3 py-2.5 border-b border-border flex-shrink-0 sm:px-4 sm:py-3"
          style={{ touchAction: "none" }}
          data-drag-handle
        >
          {canNavigate && (
            <div className="flex flex-shrink-0 items-center overflow-hidden rounded-xl border border-border bg-surface-muted">
              <button
                onClick={() => navigate(-1)}
                disabled={!hasPrev}
                className="p-2 text-muted transition-colors hover:text-foreground hover:bg-accent-muted disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-muted"
                aria-label="Previous card"
                title="Previous card (←)"
              >
                <ChevronLeftIcon className="w-5 h-5" />
              </button>
              <span className="w-px self-stretch bg-border" aria-hidden="true" />
              <button
                onClick={() => navigate(1)}
                disabled={!hasNext}
                className="p-2 text-muted transition-colors hover:text-foreground hover:bg-accent-muted disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-muted"
                aria-label="Next card"
                title="Next card (→)"
              >
                <ChevronRightIcon className="w-5 h-5" />
              </button>
            </div>
          )}

          <div className="flex items-center gap-2 min-w-0 flex-1">
            <h2 className="text-base font-bold text-foreground truncate">{card.name}</h2>
            {detailData?.rarity && (
              <span className={`text-xs font-medium flex-shrink-0 ${rarityColor}`}>
                {capitalize(detailData.rarity)}
              </span>
            )}
          </div>

          {canNavigate && (
            <span className="flex-shrink-0 text-xs tabular-nums text-muted-soft" aria-live="polite">
              {index + 1} / {total}
            </span>
          )}

          <button
            onClick={handleClose}
            className="flex-shrink-0 -mr-1 p-2.5 rounded-xl text-muted hover:text-foreground hover:bg-surface-muted transition-colors"
            aria-label="Close"
          >
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        <div
          key={`${index}-${card.id}`}
          className={`flex-1 overflow-y-auto overscroll-contain ${
            navDirection === 1
              ? "animate-card-in-right"
              : navDirection === -1
                ? "animate-card-in-left"
                : ""
          }`}
          style={{
            // Repeated from the panel wrapper: a scroll container is where the browser
            // resolves the gesture, so `pan-y` has to be declared here to keep
            // horizontal swipes out of the browser's hands.
            touchAction: "pan-y",
            ...(swipeState === "dragging"
              ? {
                  transform: `translateX(${dragX}px)`,
                  transition: "none",
                  opacity: Math.max(0.5, 1 - Math.abs(dragX) / 500),
                }
              : swipeState === "settling"
                ? {
                    transform: "translateX(0)",
                    transition: "transform 200ms ease, opacity 200ms ease",
                    opacity: 1,
                  }
                : null),
          }}
        >
          <div className="flex flex-col sm:flex-row gap-0 sm:gap-6 p-4 sm:p-6">
            <div className="flex-shrink-0 flex flex-col items-center gap-3 sm:w-64 lg:w-72">
              <div className="w-56 sm:w-full aspect-[5/7] relative rounded-lg overflow-hidden border border-border bg-surface-muted shadow-lg">
                {imageSrc ? (
                  <Image
                    src={imageSrc}
                    alt={card.name}
                    fill
                    unoptimized
                    sizes="(max-width: 640px) 192px, (max-width: 1024px) 256px, 288px"
                    className="object-cover"
                    priority
                  />
                ) : (
                  <div className="flex items-center justify-center h-full text-sm text-muted">
                    No image
                  </div>
                )}
              </div>

              {hasFaces && (
                <div className="flex gap-2">
                  {detailData!.card_faces!.map((face, i) => (
                    <button
                      key={i}
                      onClick={() => setActiveFace(i)}
                      className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                        activeFace === i
                          ? "bg-accent border-accent text-white"
                          : "bg-surface-muted border-border text-muted hover:border-accent/50 hover:text-foreground"
                      }`}
                    >
                      {face.name.split(" // ")[0] ?? face.name}
                    </button>
                  ))}
                </div>
              )}

              {detailData && (
                <div className="sm:hidden text-center text-xs text-muted space-y-0.5">
                  <p className="text-foreground font-medium">{detailData.set_name}</p>
                  <p>
                    #{detailData.collector_number} · {detailData.set.toUpperCase()}
                  </p>
                  {detailData.artist && <p>Art by {detailData.artist}</p>}
                </div>
              )}
            </div>

            <div className="flex-1 min-w-0 space-y-4 mt-4 sm:mt-0">
              {loading ? (
                <div className="space-y-3 animate-pulse">
                  <div className="h-5 bg-surface-muted rounded w-3/4" />
                  <div className="h-3 bg-surface-muted rounded w-1/2" />
                  <div className="h-3 bg-surface-muted rounded w-full" />
                  <div className="h-3 bg-surface-muted rounded w-full" />
                  <div className="h-3 bg-surface-muted rounded w-5/6" />
                </div>
              ) : detailData ? (
                <>
                  {!hasFaces ? (
                    <div className="space-y-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <h3 className="text-lg font-bold text-foreground leading-tight">
                            {detailData.name}
                          </h3>
                        </div>
                        {detailData.mana_cost && (
                          <div className="flex-shrink-0 mt-1">
                            <ManaCost manaCost={detailData.mana_cost} />
                          </div>
                        )}
                      </div>

                      <p className="text-xs font-medium text-muted uppercase tracking-wide border-b border-border pb-2">
                        {detailData.type_line}
                      </p>

                      {detailData.oracle_text && (
                        <OracleText text={detailData.oracle_text} />
                      )}

                      {detailData.flavor_text && (
                        <OracleText
                          text={detailData.flavor_text}
                          italic
                          className="border-t border-border pt-2"
                        />
                      )}

                      {(detailData.power !== undefined || detailData.toughness !== undefined) && (
                        <p className="text-sm font-bold text-foreground text-right border-t border-border pt-2">
                          {detailData.power}/{detailData.toughness}
                        </p>
                      )}
                      {detailData.loyalty !== undefined && (
                        <p className="text-sm font-bold text-foreground text-right border-t border-border pt-2">
                          Loyalty: {detailData.loyalty}
                        </p>
                      )}
                      {detailData.defense !== undefined && (
                        <p className="text-sm font-bold text-foreground text-right border-t border-border pt-2">
                          Defense: {detailData.defense}
                        </p>
                      )}
                    </div>
                  ) : (
                    /* Multi-face card: show active face */
                    <CardFaceView face={detailData.card_faces![activeFace]} />
                  )}

                  {detailData.keywords && detailData.keywords.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 border-t border-border pt-3">
                      {detailData.keywords.map((kw) => (
                        <KeywordWithTooltip
                          key={kw}
                          keyword={kw}
                          className="cursor-help px-2 py-0.5 text-xs rounded-full bg-accent-muted border border-accent/30 text-accent hover:border-accent/50"
                        />
                      ))}
                    </div>
                  )}

                  <div className="border-t border-border pt-3 space-y-1 text-xs hidden sm:block">
                    <div className="flex items-center gap-1.5">
                      <span className="text-muted-soft">Set</span>
                      <span className="text-foreground font-medium">{detailData.set_name}</span>
                      <span className="text-muted">
                        ({detailData.set.toUpperCase()} #{detailData.collector_number})
                      </span>
                    </div>
                    {detailData.artist && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-muted-soft">Artist</span>
                        <span className="text-foreground">{detailData.artist}</span>
                      </div>
                    )}
                    {detailData.released_at && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-muted-soft">Released</span>
                        <span className="text-muted">{detailData.released_at}</span>
                      </div>
                    )}
                  </div>

                  {detailData.legalities && (
                    <div className="border-t border-border pt-3">
                      <p className="text-xs text-muted-soft uppercase tracking-wide mb-2">Legalities</p>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                        {KEY_FORMATS.map(({ key, label }) => {
                          const status = detailData.legalities![key];
                          if (!status) return null;
                          const style = LEGALITY_STYLES[status] ?? LEGALITY_STYLES.not_legal;
                          return (
                            <div
                              key={key}
                              className={`flex items-center justify-between px-2 py-1 rounded border text-xs ${style.bg}`}
                            >
                              <span className="text-muted">{label}</span>
                              <span className={`font-medium ${style.text}`}>{style.label}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <div className="border-t border-border pt-3">
                    <a
                      href={card.scryfall_uri}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-accent transition-colors"
                    >
                      <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5 flex-shrink-0" />
                      <span>Open on Scryfall</span>
                    </a>
                  </div>
                </>
              ) : (
                /* Fallback to CardResult data if fetch failed */
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-lg font-bold text-foreground">{card.name}</h3>
                    {card.mana_cost && (
                      <div className="flex-shrink-0 mt-1">
                        <ManaCost manaCost={card.mana_cost} />
                      </div>
                    )}
                  </div>
                  <p className="text-xs font-medium text-gray-600 dark:text-gray-400 uppercase tracking-wide border-b border-border pb-2">
                    {card.type_line}
                  </p>
                  {card.oracle_text && <OracleText text={card.oracle_text} />}
                  <p className="text-xs text-muted-soft">{card.set_name}</p>
                  <div className="border-t border-border pt-3">
                    <a
                      href={card.scryfall_uri}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-accent transition-colors"
                    >
                      <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5 flex-shrink-0" />
                      <span>Open on Scryfall</span>
                    </a>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex-shrink-0 border-t border-border px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] bg-surface sm:pb-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-soft text-center mb-2">
            Buy here and support the project
          </p>
          <div className="flex flex-row gap-2">
            <a
              href={cardtraderUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={handleCardTraderClick}
              className={`flex flex-1 items-center justify-center gap-2 rounded-lg border border-stone-400/60 bg-stone-600 px-3 py-2.5 transition-colors hover:border-stone-400 hover:bg-stone-500 dark:border-stone-600 dark:bg-stone-700 dark:hover:bg-stone-600 ${
                isCheckingLink ? "cursor-wait opacity-60" : ""
              }`}
            >
              <Image
                src="/brand/cardtrader.svg"
                alt="CardTrader"
                width={100}
                height={20}
                unoptimized
                className="h-4 w-auto"
              />
              <span className="sr-only">Buy on CardTrader</span>
            </a>

            <a
              href={tcgPlayerUrl || "#"}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => { if (!tcgPlayerUrl) e.preventDefault(); e.stopPropagation(); }}
              className={`flex flex-1 items-center justify-center gap-2 rounded-lg border border-stone-400/60 bg-stone-600 px-3 py-2.5 transition-colors hover:border-stone-400 hover:bg-stone-500 dark:border-stone-600 dark:bg-stone-700 dark:hover:bg-stone-600 ${
                !tcgPlayerUrl ? "cursor-not-allowed opacity-50" : ""
              }`}
            >
              <Image
                src="/brand/tcgplayer.svg"
                alt="TCGPlayer"
                width={100}
                height={20}
                unoptimized
                className="h-4 w-auto"
              />
              <span className="sr-only">Buy on TCGPlayer</span>
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
