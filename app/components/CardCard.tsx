"use client";

import { CardResult } from "@/types/scryfall";
import { getCardTraderLink, getCardTraderHomepageLink } from "@/lib/cardtrader/links";
import ManaCost from "@/app/components/ManaCost";
import Image from "next/image";
import { useState } from "react";

interface CardCardProps {
  card: CardResult;
  onCardClick?: (card: CardResult) => void;
}

export default function CardCard({ card, onCardClick }: CardCardProps) {
  const [isCheckingLink, setIsCheckingLink] = useState(false);
  const initialImageSrc = card.image_uris.normal || card.image_uris.small || "";
  const [imageSrc, setImageSrc] = useState(initialImageSrc);
  const [imageFailed, setImageFailed] = useState(false);

  const handleClick = () => {
    if (onCardClick) {
      onCardClick(card);
    } else {
      window.open(card.scryfall_uri, "_blank", "noopener,noreferrer");
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

    // Check if link is 404
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
      // On error, assume 404 and redirect to homepage
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
      className="group cursor-pointer rounded-lg border border-gray-800 bg-gray-900 p-2 transition-all hover:border-gray-700 hover:shadow-lg hover:shadow-blue-500/10 sm:p-4"
    >
      {/* Card Image */}
      {imageSrc && !imageFailed ? (
        <div className="mb-2 aspect-[5/7] overflow-hidden rounded border border-gray-800 bg-gray-950 relative sm:mb-3">
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
      ) : (
        <div className="mb-2 flex aspect-[5/7] items-center justify-center rounded border border-gray-800 bg-gray-950 text-xs text-gray-600 sm:mb-3">
          No image
        </div>
      )}

      {/* Card Name & Mana Cost */}
      <div className="mb-2 flex items-start justify-between gap-1 sm:mb-3 sm:gap-2">
        <h3 className="flex-1 min-w-0 text-xs font-semibold text-gray-100 group-hover:text-blue-400 line-clamp-2 sm:text-base sm:pr-2">
          {card.name}
        </h3>
        <div className="hidden flex-shrink-0 mt-0.5 min-w-[60px] items-center justify-end sm:flex">
          {card.mana_cost ? (
            <ManaCost manaCost={card.mana_cost} />
          ) : (
            <span className="text-xs text-gray-500">—</span>
          )}
        </div>
      </div>

      <div className="hidden text-center text-xs font-semibold uppercase tracking-wide text-gray-400 sm:block">
        Buy this card
      </div>
      <div className="mt-1 flex gap-1.5 sm:mt-2 sm:gap-2">
        {/* CardTrader Affiliate Link */}
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
          className={`flex flex-1 items-center justify-center rounded border border-gray-700 bg-gray-800/50 p-2 transition-colors hover:border-blue-600 hover:bg-gray-800 sm:p-3 ${
            isCheckingLink ? "cursor-wait opacity-60" : "hover:opacity-100"
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

        {/* TCGPlayer Link */}
        <a
          href={tcgPlayerUrl || "#"}
          target="_blank"
          rel="noopener noreferrer"
          onClick={handleTcgPlayerClick}
          className={`flex flex-1 items-center justify-center rounded border border-gray-700 bg-gray-800/50 p-2 transition-colors hover:border-blue-600 hover:bg-gray-800 sm:p-3 ${
            tcgPlayerUrl ? "hover:opacity-100" : "cursor-not-allowed opacity-50"
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
