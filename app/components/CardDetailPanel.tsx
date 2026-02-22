"use client";

import { CardResult, CardDetailData } from "@/types/scryfall";
import { useEffect, useState, useCallback } from "react";
import Image from "next/image";
import ManaCost from "@/app/components/ManaCost";
import OracleText from "@/app/components/OracleText";
import KeywordWithTooltip from "@/app/components/KeywordWithTooltip";
import { XMarkIcon, ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import { getCardTraderLink, getCardTraderHomepageLink } from "@/lib/cardtrader/links";

interface CardDetailPanelProps {
  card: CardResult;
  onClose: () => void;
}

const RARITY_COLORS: Record<string, string> = {
  common: "text-gray-400",
  uncommon: "text-slate-300",
  rare: "text-yellow-400",
  mythic: "text-orange-400",
  special: "text-purple-400",
  bonus: "text-purple-400",
};

const LEGALITY_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  legal: { bg: "bg-green-900/60 border-green-700/50", text: "text-green-300", label: "Legal" },
  not_legal: { bg: "bg-gray-800/60 border-gray-700/50", text: "text-gray-500", label: "Not Legal" },
  banned: { bg: "bg-red-900/60 border-red-700/50", text: "text-red-400", label: "Banned" },
  restricted: { bg: "bg-yellow-900/60 border-yellow-700/50", text: "text-yellow-400", label: "Restricted" },
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
        <h3 className="text-base font-bold text-gray-100">{face.name}</h3>
        {face.mana_cost && (
          <div className="flex-shrink-0 mt-0.5">
            <ManaCost manaCost={face.mana_cost} />
          </div>
        )}
      </div>

      {face.type_line && (
        <p className="text-xs font-medium text-gray-400 uppercase tracking-wide border-b border-gray-800 pb-2">
          {face.type_line}
        </p>
      )}

      {face.oracle_text && (
        <OracleText text={face.oracle_text} />
      )}

      {face.flavor_text && (
        <OracleText text={face.flavor_text} italic className="border-t border-gray-800 pt-2" />
      )}

      {(face.power !== undefined || face.toughness !== undefined) && (
        <p className="text-sm font-bold text-gray-200 text-right">
          {face.power}/{face.toughness}
        </p>
      )}
      {face.loyalty !== undefined && (
        <p className="text-sm font-bold text-gray-200 text-right">
          Loyalty: {face.loyalty}
        </p>
      )}
      {face.defense !== undefined && (
        <p className="text-sm font-bold text-gray-200 text-right">
          Defense: {face.defense}
        </p>
      )}
    </div>
  );
}

export default function CardDetailPanel({ card, onClose }: CardDetailPanelProps) {
  const [detailData, setDetailData] = useState<CardDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeFace, setActiveFace] = useState(0);
  const [isCheckingLink, setIsCheckingLink] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Trigger enter animation
    const t = setTimeout(() => setVisible(true), 10);
    return () => clearTimeout(t);
  }, []);

  const handleClose = useCallback(() => {
    setVisible(false);
    setTimeout(onClose, 200);
  }, [onClose]);

  useEffect(() => {
    const fetchCardData = async () => {
      setLoading(true);
      try {
        const response = await fetch(`/api/card/${card.id}`);
        if (response.ok) {
          const data: CardDetailData = await response.json();
          setDetailData(data);
        }
      } catch (err) {
        console.error("[CardDetailPanel] Failed to fetch card details:", err);
      } finally {
        setLoading(false);
      }
    };
    fetchCardData();
  }, [card.id]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") handleClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleClose]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
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

  // Determine which image to display
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
        visible ? "bg-black/70 backdrop-blur-sm" : "bg-black/0"
      }`}
      onClick={handleClose}
    >
      <div
        className={`relative w-full sm:max-w-4xl max-h-[95dvh] sm:max-h-[90dvh] bg-gray-950 border border-gray-800 rounded-t-2xl sm:rounded-2xl flex flex-col overflow-hidden shadow-2xl transition-all duration-200 ${
          visible
            ? "opacity-100 translate-y-0 sm:scale-100"
            : "opacity-0 translate-y-8 sm:scale-95"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-base font-bold text-gray-100 truncate">{card.name}</h2>
            {detailData?.rarity && (
              <span className={`text-xs font-medium flex-shrink-0 ${rarityColor}`}>
                {capitalize(detailData.rarity)}
              </span>
            )}
          </div>
          <button
            onClick={handleClose}
            className="flex-shrink-0 ml-3 p-1.5 rounded-lg text-gray-400 hover:text-gray-100 hover:bg-gray-800 transition-colors"
            aria-label="Close"
          >
            <XMarkIcon className="w-5 h-5" />
          </button>
        </div>

        {/* Main content (scrollable) */}
        <div className="flex-1 overflow-y-auto">
          <div className="flex flex-col sm:flex-row gap-0 sm:gap-6 p-4 sm:p-6">
            {/* Left: Card Image */}
            <div className="flex-shrink-0 flex flex-col items-center gap-3 sm:w-64 lg:w-72">
              <div className="w-48 sm:w-full aspect-[5/7] relative rounded-lg overflow-hidden border border-gray-800 bg-gray-900 shadow-lg">
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
                  <div className="flex items-center justify-center h-full text-sm text-gray-600">
                    No image
                  </div>
                )}
              </div>

              {/* Face toggle for DFC */}
              {hasFaces && (
                <div className="flex gap-2">
                  {detailData!.card_faces!.map((face, i) => (
                    <button
                      key={i}
                      onClick={() => setActiveFace(i)}
                      className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                        activeFace === i
                          ? "bg-blue-600 border-blue-500 text-white"
                          : "bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-600 hover:text-gray-200"
                      }`}
                    >
                      {face.name.split(" // ")[0] ?? face.name}
                    </button>
                  ))}
                </div>
              )}

              {/* Set info on mobile (below image) */}
              {detailData && (
                <div className="sm:hidden text-center text-xs text-gray-500 space-y-0.5">
                  <p className="text-gray-400 font-medium">{detailData.set_name}</p>
                  <p>
                    #{detailData.collector_number} · {detailData.set.toUpperCase()}
                  </p>
                  {detailData.artist && <p>Art by {detailData.artist}</p>}
                </div>
              )}
            </div>

            {/* Right: Card Details */}
            <div className="flex-1 min-w-0 space-y-4 mt-4 sm:mt-0">
              {loading ? (
                <div className="space-y-3 animate-pulse">
                  <div className="h-5 bg-gray-800 rounded w-3/4" />
                  <div className="h-3 bg-gray-800 rounded w-1/2" />
                  <div className="h-3 bg-gray-800 rounded w-full" />
                  <div className="h-3 bg-gray-800 rounded w-full" />
                  <div className="h-3 bg-gray-800 rounded w-5/6" />
                </div>
              ) : detailData ? (
                <>
                  {/* Single-face or no faces: show card-level data */}
                  {!hasFaces ? (
                    <div className="space-y-3">
                      {/* Name + mana cost */}
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <h3 className="text-lg font-bold text-gray-100 leading-tight">
                            {detailData.name}
                          </h3>
                        </div>
                        {detailData.mana_cost && (
                          <div className="flex-shrink-0 mt-1">
                            <ManaCost manaCost={detailData.mana_cost} />
                          </div>
                        )}
                      </div>

                      {/* Type line */}
                      <p className="text-xs font-medium text-gray-400 uppercase tracking-wide border-b border-gray-800 pb-2">
                        {detailData.type_line}
                      </p>

                      {/* Oracle text */}
                      {detailData.oracle_text && (
                        <OracleText text={detailData.oracle_text} />
                      )}

                      {/* Flavor text */}
                      {detailData.flavor_text && (
                        <OracleText
                          text={detailData.flavor_text}
                          italic
                          className="border-t border-gray-800 pt-2"
                        />
                      )}

                      {/* P/T or Loyalty */}
                      {(detailData.power !== undefined || detailData.toughness !== undefined) && (
                        <p className="text-sm font-bold text-gray-200 text-right border-t border-gray-800 pt-2">
                          {detailData.power}/{detailData.toughness}
                        </p>
                      )}
                      {detailData.loyalty !== undefined && (
                        <p className="text-sm font-bold text-gray-200 text-right border-t border-gray-800 pt-2">
                          Loyalty: {detailData.loyalty}
                        </p>
                      )}
                      {detailData.defense !== undefined && (
                        <p className="text-sm font-bold text-gray-200 text-right border-t border-gray-800 pt-2">
                          Defense: {detailData.defense}
                        </p>
                      )}
                    </div>
                  ) : (
                    /* Multi-face card: show active face */
                    <CardFaceView face={detailData.card_faces![activeFace]} />
                  )}

                  {/* Keywords */}
                  {detailData.keywords && detailData.keywords.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 border-t border-gray-800 pt-3">
                      {detailData.keywords.map((kw) => (
                        <KeywordWithTooltip
                          key={kw}
                          keyword={kw}
                          className="cursor-help px-2 py-0.5 text-xs rounded-full bg-blue-950/60 border border-blue-800/50 text-blue-300 hover:border-blue-700"
                        />
                      ))}
                    </div>
                  )}

                  {/* Set / Collector / Artist */}
                  <div className="border-t border-gray-800 pt-3 space-y-1 text-xs text-gray-500 hidden sm:block">
                    <div className="flex items-center gap-1.5">
                      <span className="text-gray-600">Set</span>
                      <span className="text-gray-300 font-medium">{detailData.set_name}</span>
                      <span className="text-gray-600">
                        ({detailData.set.toUpperCase()} #{detailData.collector_number})
                      </span>
                    </div>
                    {detailData.artist && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-gray-600">Artist</span>
                        <span className="text-gray-300">{detailData.artist}</span>
                      </div>
                    )}
                    {detailData.released_at && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-gray-600">Released</span>
                        <span className="text-gray-400">{detailData.released_at}</span>
                      </div>
                    )}
                  </div>

                  {/* Legalities */}
                  {detailData.legalities && (
                    <div className="border-t border-gray-800 pt-3">
                      <p className="text-xs text-gray-600 uppercase tracking-wide mb-2">Legalities</p>
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
                              <span className="text-gray-400">{label}</span>
                              <span className={`font-medium ${style.text}`}>{style.label}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Open on Scryfall (below legalities) */}
                  <div className="border-t border-gray-800 pt-3">
                    <a
                      href={card.scryfall_uri}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-blue-400 transition-colors"
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
                    <h3 className="text-lg font-bold text-gray-100">{card.name}</h3>
                    {card.mana_cost && (
                      <div className="flex-shrink-0 mt-1">
                        <ManaCost manaCost={card.mana_cost} />
                      </div>
                    )}
                  </div>
                  <p className="text-xs font-medium text-gray-400 uppercase tracking-wide border-b border-gray-800 pb-2">
                    {card.type_line}
                  </p>
                  {card.oracle_text && <OracleText text={card.oracle_text} />}
                  <p className="text-xs text-gray-600">{card.set_name}</p>
                  <div className="border-t border-gray-800 pt-3">
                    <a
                      href={card.scryfall_uri}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-blue-400 transition-colors"
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

        {/* Footer: Buy buttons (side by side) */}
        <div className="flex-shrink-0 border-t border-gray-800 px-4 py-3 bg-gray-950">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 text-center mb-2">
            Buy here and support the project
          </p>
          <div className="flex flex-row gap-2">
            {/* CardTrader */}
            <a
              href={cardtraderUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={handleCardTraderClick}
              className={`flex flex-1 items-center justify-center gap-2 rounded-lg border border-gray-700 bg-gray-800/50 px-3 py-2.5 text-xs font-medium text-gray-300 transition-colors hover:border-blue-600 hover:bg-gray-800 hover:text-white ${
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

            {/* TCGPlayer */}
            <a
              href={tcgPlayerUrl || "#"}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => { if (!tcgPlayerUrl) e.preventDefault(); e.stopPropagation(); }}
              className={`flex flex-1 items-center justify-center gap-2 rounded-lg border border-gray-700 bg-gray-800/50 px-3 py-2.5 text-xs font-medium text-gray-300 transition-colors hover:border-blue-600 hover:bg-gray-800 hover:text-white ${
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
