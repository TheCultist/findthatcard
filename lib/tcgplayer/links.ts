type TcgPlayerLinkInput = {
  tcgplayerId?: number | null;
  destinationUrl?: string | null;
};

export function getTcgPlayerLink({
  tcgplayerId,
  destinationUrl,
}: TcgPlayerLinkInput): string | null {
  const partnerLink =
    process.env.TCG_PLAYER_PARTNER_LINK ||
    process.env.NEXT_PUBLIC_TCG_PLAYER_PARTNER_LINK ||
    "";

  if (!partnerLink) {
    return null;
  }

  const fallbackHomepage = "https://www.tcgplayer.com";
  let destination =
    destinationUrl || (tcgplayerId ? `https://www.tcgplayer.com/product/${tcgplayerId}` : "");

  if (destinationUrl) {
    try {
      const parsed = new URL(destinationUrl);
      const nested = parsed.searchParams.get("u");
      if (nested) {
        destination = nested;
      } else if (!destination) {
        destination = fallbackHomepage;
      }
    } catch {
      destination = destination || fallbackHomepage;
    }
  }

  if (!destination) {
    destination = fallbackHomepage;
  }

  return `${partnerLink}?u=${encodeURIComponent(destination)}`;
}
