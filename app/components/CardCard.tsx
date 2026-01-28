"use client";

import { CardResult } from "@/types/scryfall";
import { getCardTraderLink } from "@/lib/cardtrader/links";
import ManaCost from "@/app/components/ManaCost";

export default function CardCard({ card }: { card: CardResult }) {
  const handleClick = () => {
    window.open(card.scryfall_uri, "_blank", "noopener,noreferrer");
  };

  return (
    <div
      onClick={handleClick}
      className="group cursor-pointer rounded-lg border border-gray-800 bg-gray-900 p-4 transition-all hover:border-gray-700 hover:shadow-lg hover:shadow-blue-500/10"
    >
      {/* Card Image */}
      {card.image_uris.normal || card.image_uris.small ? (
        <div className="mb-3 aspect-[5/7] overflow-hidden rounded border border-gray-800 bg-gray-950">
          <img
            src={card.image_uris.normal || card.image_uris.small || ""}
            alt={card.name}
            className="h-full w-full object-cover transition-transform group-hover:scale-105"
            loading="lazy"
            onError={(e) => {
              const target = e.target as HTMLImageElement;
              // Try fallback to small if normal fails
              if (card.image_uris.small && target.src !== card.image_uris.small) {
                target.src = card.image_uris.small;
              } else {
                target.style.display = "none";
              }
            }}
          />
        </div>
      ) : (
        <div className="mb-3 flex aspect-[5/7] items-center justify-center rounded border border-gray-800 bg-gray-950 text-xs text-gray-600">
          No image
        </div>
      )}

      {/* Card Name & Mana Cost */}
      <div className="mb-3 flex items-start justify-between gap-2">
        <h3 className="flex-1 min-w-0 font-semibold text-gray-100 group-hover:text-blue-400 line-clamp-2 pr-2">
          {card.name}
        </h3>
        <div className="flex-shrink-0 mt-0.5 min-w-[60px] flex items-center justify-end">
          {card.mana_cost ? (
            <ManaCost manaCost={card.mana_cost} />
          ) : (
            <span className="text-xs text-gray-500">—</span>
          )}
        </div>
      </div>

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
        onClick={(e) => e.stopPropagation()}
        className="block rounded border border-gray-700 bg-gray-800/50 p-3 text-center text-xs text-gray-400 transition-colors hover:border-blue-600 hover:bg-gray-800 hover:text-blue-400"
      >
        Buy on CardTrader
      </a>
    </div>
  );
}
