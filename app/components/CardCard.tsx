"use client";

import { CardResult } from "@/types/scryfall";
import { getCardTraderLink, getCardTraderHomepageLink } from "@/lib/cardtrader/links";
import ManaCost from "@/app/components/ManaCost";
import Image from "next/image";
import { useState, useEffect } from "react";

interface CardCardProps {
  card: CardResult;
  onCardClick?: (card: CardResult) => void;
}

export default function CardCard({ card, onCardClick }: CardCardProps) {
  const [isCheckingLink, setIsCheckingLink] = useState(false);
  const [activeFaceIndex, setActiveFaceIndex] = useState(0);
  const [imageFailed, setImageFailed] = useState(false);
  const [isFlipping, setIsFlipping] = useState(false);
  
  const hasFaces = card.card_faces && card.card_faces.length > 1;
  
  const getImageSrc = () => {
    if (hasFaces && card.card_faces![activeFaceIndex].image_uris) {
      const faceImage = card.card_faces![activeFaceIndex].image_uris;
      return faceImage!.normal || faceImage!.small || "";
    }
    return card.image_uris.normal || card.image_uris.small || "";
  };
  
  const [imageSrc, setImageSrc] = useState(() => getImageSrc());

  useEffect(() => {
    const newSrc = getImageSrc();
    setImageSrc(newSrc);
    setImageFailed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFaceIndex]);

  const handleClick = () => {
    if (onCardClick) {
      onCardClick(card);
    } else {
      window.open(card.scryfall_uri, "_blank", "noopener,noreferrer");
    }
  };
  
  const handleFlipClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (hasFaces && !isFlipping) {
      setIsFlipping(true);
      setTimeout(() => {
        setActiveFaceIndex((prev) => (prev + 1) % card.card_faces!.length);
      }, 150);
      setTimeout(() => {
        setIsFlipping(false);
      }, 300);
    }
  };

  const handleCardTraderClick = async (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.stopPropagation();
    e.preventDefault();

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

      if (data.is404) {
        // Redirect to CardTrader homepage with share code
        const homepageUrl = getCardTraderHomepageLink();
        window.open(homepageUrl, "_blank", "noopener,noreferrer");
      } else {
        // Link is valid, open it
        window.open(cardtraderUrl, "_blank", "noopener,noreferrer");
      }
    } catch (error) {
      console.error("[CardCard] Error checking CardTrader link:", error);
      const homepageUrl = getCardTraderHomepageLink();
      window.open(homepageUrl, "_blank", "noopener,noreferrer");
    } finally {
      setIsCheckingLink(false);
    }
  };

  const tcgPlayerUrl = card.tcgplayer_link;

  const handleTcgPlayerClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.stopPropagation();
    if (!tcgPlayerUrl) {
      e.preventDefault();
    }
  };

  return (
    <div
      onClick={handleClick}
      className="group cursor-pointer rounded-xl border border-border bg-surface-muted p-2 transition-all hover:border-accent/40 hover:shadow-lg hover:shadow-accent/5 sm:p-4"
    >
      {imageSrc && !imageFailed ? (
        <div className="mb-2 aspect-[5/7] overflow-hidden rounded-lg border border-border bg-surface relative sm:mb-3">
          <div className={`w-full h-full transition-all duration-300 ${isFlipping ? 'scale-x-0 opacity-0' : 'scale-x-100 opacity-100'}`}>
            <Image
              src={imageSrc}
              alt={card.name}
              fill
              sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
              unoptimized
              className="object-cover transition-transform group-hover:scale-105"
              onError={() => {
                if (card.image_uris.small && imageSrc !== card.image_uris.small) {
                  setImageSrc(card.image_uris.small);
                } else {
                  setImageFailed(true);
                }
              }}
            />
          </div>
          {hasFaces && (
            <button
              onClick={handleFlipClick}
              className="absolute top-2 right-2 rounded-full bg-black/60 p-2 text-white shadow-lg transition-all hover:bg-black/80 hover:scale-110 focus:outline-none focus:ring-2 focus:ring-accent/50 backdrop-blur-sm z-10"
              aria-label="Flip card"
              title="Flip card"
              disabled={isFlipping}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2}
                stroke="currentColor"
                className={`h-4 w-4 transition-transform duration-300 ${isFlipping ? 'rotate-180' : ''}`}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"
                />
              </svg>
            </button>
          )}
        </div>
      ) : (
        <div className="mb-2 flex aspect-[5/7] items-center justify-center rounded-lg border border-border bg-surface text-xs text-muted sm:mb-3">
          No image
        </div>
      )}

      <div className="mb-2 flex items-start justify-between gap-1 sm:mb-3 sm:gap-2">
        <h3 className="flex-1 min-w-0 text-xs font-semibold text-foreground line-clamp-2 group-hover:text-accent sm:text-base sm:pr-2">
          {card.name}
        </h3>
        <div className="hidden flex-shrink-0 mt-0.5 min-w-[60px] items-center justify-end sm:flex">
          {card.mana_cost ? (
            <ManaCost manaCost={card.mana_cost} />
          ) : (
            <span className="text-xs text-muted">—</span>
          )}
        </div>
      </div>

      <div className="hidden text-center text-xs font-semibold uppercase tracking-wide text-muted sm:block">
        Buy this card
      </div>
      <div className="mt-1 flex gap-1.5 sm:mt-2 sm:gap-2">
        <a
          href={getCardTraderLink(
            card.name,
            card.set_name,
            card.set_code,
            card.collector_number
          )}
          target="_blank"
          rel="noopener noreferrer"
          onClick={handleCardTraderClick}
          className={`flex flex-1 items-center justify-center rounded-lg border border-stone-400/60 bg-stone-600 p-2 transition-colors hover:border-stone-400 hover:bg-stone-500 dark:border-stone-600 dark:bg-stone-700 dark:hover:bg-stone-600 sm:p-3 ${
            isCheckingLink ? "cursor-wait opacity-60" : ""
          }`}
          aria-label="Buy on CardTrader"
          aria-disabled={isCheckingLink}
        >
          <span className="sr-only">
            {isCheckingLink ? "Checking CardTrader link" : "Buy on CardTrader"}
          </span>
          <Image
            src="/brand/cardtrader.svg"
            alt="CardTrader"
            width={120}
            height={24}
            unoptimized
            className="h-4 w-auto sm:h-6"
          />
        </a>

        <a
          href={tcgPlayerUrl || "#"}
          target="_blank"
          rel="noopener noreferrer"
          onClick={handleTcgPlayerClick}
          className={`flex flex-1 items-center justify-center rounded-lg border border-stone-400/60 bg-stone-600 p-2 transition-colors hover:border-stone-400 hover:bg-stone-500 dark:border-stone-600 dark:bg-stone-700 dark:hover:bg-stone-600 sm:p-3 ${
            !tcgPlayerUrl ? "cursor-not-allowed opacity-50" : ""
          }`}
          aria-label="Buy on TCGPlayer"
          aria-disabled={!tcgPlayerUrl}
        >
          <span className="sr-only">Buy on TCGPlayer</span>
          <Image
            src="/brand/tcgplayer.svg"
            alt="TCGPlayer"
            width={120}
            height={24}
            unoptimized
            className="h-4 w-auto sm:h-6"
          />
        </a>
      </div>
    </div>
  );
}
