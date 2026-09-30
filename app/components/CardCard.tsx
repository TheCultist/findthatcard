"use client";

import { CardResult } from "@/types/scryfall";
import { getStoreOffers, prefersTcgPlayer, STORE_BUTTON_CLASS } from "@/lib/prices";
import ManaCost from "@/app/components/ManaCost";
import Image from "next/image";
import { track } from "@vercel/analytics";
import { useState, useEffect } from "react";

interface CardCardProps {
  card: CardResult;
  onCardClick?: (card: CardResult) => void;
}

export default function CardCard({ card, onCardClick }: CardCardProps) {
  const [activeFaceIndex, setActiveFaceIndex] = useState(0);
  const [imageFailed, setImageFailed] = useState(false);
  const [isFlipping, setIsFlipping] = useState(false);
  // Results arrive from a client fetch, so this never runs during SSR.
  const [tcgFirst] = useState(prefersTcgPlayer);
  
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
    track("card_open", { card: card.name });
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

  // Each price is itself the buy link: one click from the grid to the store.
  const offers = getStoreOffers(card, tcgFirst).filter((o) => o.price);

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

      <div className="flex items-start justify-between gap-1 sm:gap-2">
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

      {offers.length > 0 && (
        <div className="mt-2 flex gap-1.5 sm:mt-3 sm:gap-2">
          {offers.map((o) => (
            <a
              key={o.id}
              href={o.href ?? "#"}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Buy on ${o.name} from ${o.price}`}
              aria-disabled={!o.href}
              onClick={(e) => {
                e.stopPropagation();
                if (!o.href) {
                  e.preventDefault();
                  return;
                }
                track("buy_click", { store: o.id, surface: "grid", card: card.name });
              }}
              className={`${STORE_BUTTON_CLASS} flex min-w-0 flex-1 flex-col items-center justify-center gap-1 px-2 py-1.5 ${
                o.href ? "" : "cursor-not-allowed opacity-50"
              }`}
            >
              <span className="text-xs font-semibold tabular-nums text-white sm:text-sm">{o.price}</span>
              <Image
                src={o.logo}
                alt={o.name}
                width={100}
                height={20}
                unoptimized
                className="h-3 w-auto max-w-full object-contain sm:h-3.5"
              />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
