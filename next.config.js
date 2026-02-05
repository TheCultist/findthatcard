/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "cards.scryfall.io" },
      { protocol: "https", hostname: "img.scryfall.com" },
    ],
    formats: ["image/webp"],
    deviceSizes: [320, 640, 960, 1280],
    imageSizes: [16, 24, 32, 48, 64, 96, 120, 180],
    minimumCacheTTL: 2678400,
  },
};

module.exports = nextConfig;
